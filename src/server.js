const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const env = require("./config/env");
const { parseRecipients } = require("./services/uploadService");
const { buildBatches } = require("./services/batchService");
const {
  addUpload,
  getUploadById,
  getLatestUpload,
  createRun,
  getRunReport,
  getRunSummary,
  getTodayQueuedEmailCount,
  markStaleInProgressAsFailed,
} = require("./services/reportService");
const { enqueueRunJobs } = require("./services/queueDispatchService");
const { startQueueWorker } = require("./queue/worker");

const app = express();
const uploadsDir = path.resolve(__dirname, "../tmp/uploads");
const resumesDir = path.resolve(__dirname, "../tmp/resumes");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(resumesDir, { recursive: true });

const uploadExcel = multer({ dest: uploadsDir });
const uploadResume = multer({ dest: resumesDir });
const configuredFrontendOrigin = String(env.frontendOrigin || "").trim();
const allowedOrigins = new Set(
  [
    configuredFrontendOrigin,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "https://bulkmailsending-frontend.vercel.app/",
    
  ].filter(Boolean)
);

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function clampInteger(value, fallback, min, max) {
  const parsed = parseInteger(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
  } catch (_error) {
    return false;
  }

  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked for origin: ${origin || "unknown"}`));
  },
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

startQueueWorker();
markStaleInProgressAsFailed(env.staleInProgressMinutes).catch(() => {});
setInterval(() => {
  markStaleInProgressAsFailed(env.staleInProgressMinutes).catch(() => {});
}, 60 * 1000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/upload", uploadExcel.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Excel file is required" });
    }

    if (!req.file.originalname.toLowerCase().endsWith(".xlsx")) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ message: "Only .xlsx files are supported" });
    }

    const { recipients, invalidRows } = parseRecipients(req.file.path);
    await fs.promises.unlink(req.file.path).catch(() => {});

    if (!recipients.length) {
      return res.status(400).json({
        message: "No valid recipients found in file",
        invalidRows,
      });
    }

    const upload = await addUpload({
      filename: req.file.originalname,
      recipients,
    });

    return res.status(201).json({
      message: "Upload parsed successfully",
      uploadId: upload.uploadId,
      totalRecipients: upload.totalRecipients,
      invalidRows,
      detectedColumns: {
        hasCompany: recipients.some((item) => Boolean(item.company)),
        hasGroup: recipients.some((item) => Boolean(item.group)),
        hasBatch: recipients.some((item) => Boolean(item.batch)),
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to parse upload",
      error: error.message,
    });
  }
});

app.post("/send-mails", uploadResume.single("resume"), async (req, res) => {
  try {
    const uploadId = String(req.body.uploadId || "").trim();
    const subject = String(req.body.subject || "").trim();
    const template = String(req.body.template || "").trim();

    if (!subject || !template) {
      return res.status(400).json({ message: "Subject and template are required" });
    }

    const upload = uploadId ? await getUploadById(uploadId) : await getLatestUpload();
    if (!upload) {
      return res.status(404).json({ message: "Upload not found. Please upload an Excel file first." });
    }

    const batchMode = String(req.body.batchMode || "manual").toLowerCase() === "column" ? "column" : "manual";
    const batchColumn = String(req.body.batchColumn || "").trim().toLowerCase();
    const batchSize = parseInteger(req.body.batchSize, 10);
    const batchSequence = String(req.body.batchSequence || "").trim();
    const batchDelaySeconds = clampInteger(req.body.batchDelaySeconds, 60, 60, 300);
    const perEmailMinDelaySeconds = clampInteger(req.body.perEmailMinDelaySeconds, 2, 2, 5);
    const perEmailMaxDelaySeconds = clampInteger(req.body.perEmailMaxDelaySeconds, 5, 2, 5);
    const smtpHost = String(req.body.smtpHost || env.smtpHost || "").trim();
    const smtpPort = clampInteger(req.body.smtpPort, env.smtpPort || 465, 1, 65535);
    const smtpSecure = parseBoolean(req.body.smtpSecure, env.smtpSecure);
    const smtpUser = String(req.body.smtpUser || env.smtpUser || "").trim();
    const smtpPass = String(req.body.smtpPass || env.smtpPass || "").trim();
    const smtpFrom = String(req.body.smtpFrom || "").trim() || smtpUser || env.smtpFrom || "";

    if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
      return res.status(400).json({
        message: "SMTP details are required: smtpHost, smtpUser, smtpPass, smtpFrom",
      });
    }

    const { batches, resolvedBatchMode, resolvedBatchColumn } = buildBatches(upload.recipients, {
      batchMode,
      batchColumn,
      batchSize,
      batchSequence,
    });

    const recipientsWithBatch = batches.flatMap((batch) =>
      batch.recipients.map((recipient) => ({
        ...recipient,
        batchKey: batch.batchKey,
      }))
    );

    const queuedToday = await getTodayQueuedEmailCount();
    const projectedTotal = queuedToday + recipientsWithBatch.length;
    if (projectedTotal > env.dailyEmailLimit) {
      return res.status(400).json({
        message: `Daily safe limit exceeded. Today's queued emails: ${queuedToday}, this run: ${recipientsWithBatch.length}, limit: ${env.dailyEmailLimit}.`,
      });
    }

    const run = await createRun({
      uploadId: upload.uploadId,
      subject,
      template,
      resumePath: req.file?.path || null,
      resumeFilename: req.file?.originalname || null,
      config: {
        batchMode: resolvedBatchMode,
        batchColumn: resolvedBatchColumn,
        batchSize,
        batchSequence,
        batchDelaySeconds,
        perEmailMinDelaySeconds,
        perEmailMaxDelaySeconds,
        smtp: {
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          user: smtpUser,
          from: smtpFrom,
        },
      },
      recipients: recipientsWithBatch,
    });

    const queueResult = await enqueueRunJobs({
      runId: run.runId,
      subject,
      template,
      resumePath: req.file?.path || null,
      resumeFilename: req.file?.originalname || null,
      batches: batches.map((batch) => ({
        ...batch,
        recipients: batch.recipients.map((recipient) => ({
          ...recipient,
          batchKey: batch.batchKey,
        })),
      })),
      batchDelaySeconds,
      perEmailMinDelaySeconds,
      perEmailMaxDelaySeconds,
      smtpConfig: {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom,
      },
    });
    return res.status(202).json({
      message: "Emails queued successfully",
      runId: run.runId,
      totalEmails: run.totalEmails,
      batchCount: batches.length,
      config: run.config,
      queue: queueResult,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to queue emails",
      error: error.message,
    });
  }
});

app.get("/report", async (req, res) => {
  try {
    const runId = String(req.query.runId || "").trim();
    const report = await getRunReport(runId || undefined);
    if (!report) {
      return res.status(404).json({ message: "No report found" });
    }
    return res.json(report);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch report", error: error.message });
  }
});

app.get("/report/summary", async (req, res) => {
  try {
    const runId = String(req.query.runId || "").trim();
    const summary = await getRunSummary(runId || undefined);
    if (!summary) {
      return res.status(404).json({ message: "No summary found" });
    }
    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch summary", error: error.message });
  }
});

app.get("/progress/:runId", async (req, res) => {
  try {
    const summary = await getRunSummary(req.params.runId);
    if (!summary) {
      return res.status(404).json({ message: "Run not found" });
    }
    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch progress", error: error.message });
  }
});

app.listen(env.port, () => {
  console.log(`Backend running on http://localhost:${env.port}`);
});
