const { randomUUID } = require("crypto");
const { withData, readOnly } = require("../storage/jsonStore");

function deepClone(value) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value));
}

function toMs(isoString) {
  if (!isoString) return 0;
  const ms = new Date(isoString).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function recomputeStats(run) {
  const total = run.records.length;
  let successCount = 0;
  let failedCount = 0;
  let processedCount = 0;
  const batchSummaryMap = new Map();
  const groupSummaryMap = new Map();

  run.records.forEach((record) => {
    const batchKey = record.batchKey || "Batch 1";
    if (!batchSummaryMap.has(batchKey)) {
      batchSummaryMap.set(batchKey, {
        batchKey,
        total: 0,
        sent: 0,
        failed: 0,
        pending: 0,
      });
    }
    const batchStats = batchSummaryMap.get(batchKey);
    batchStats.total += 1;

    if (record.status === "success") {
      successCount += 1;
      processedCount += 1;
      batchStats.sent += 1;
    } else if (record.status === "failed") {
      failedCount += 1;
      processedCount += 1;
      batchStats.failed += 1;
    } else {
      batchStats.pending += 1;
    }

    const group = String(record.group || "").trim();
    if (group) {
      if (!groupSummaryMap.has(group)) {
        groupSummaryMap.set(group, {
          group,
          total: 0,
          sent: 0,
          failed: 0,
          pending: 0,
        });
      }
      const groupStats = groupSummaryMap.get(group);
      groupStats.total += 1;
      if (record.status === "success") {
        groupStats.sent += 1;
      } else if (record.status === "failed") {
        groupStats.failed += 1;
      } else {
        groupStats.pending += 1;
      }
    }
  });

  run.totalEmails = total;
  run.successCount = successCount;
  run.failedCount = failedCount;
  run.processedCount = processedCount;
  run.pendingCount = Math.max(0, total - processedCount);
  run.batchSummary = Array.from(batchSummaryMap.values());
  run.groupSummary = Array.from(groupSummaryMap.values());

  if (total > 0 && processedCount === total) {
    run.status = "completed";
    if (!run.completedAt) {
      run.completedAt = new Date().toISOString();
    }
  }
}

function findRunById(data, runId) {
  if (!runId) return null;
  return data.runs.find((run) => run.runId === runId) || null;
}

function isSameUtcDate(isoDate, targetDate) {
  const value = new Date(isoDate);
  return (
    value.getUTCFullYear() === targetDate.getUTCFullYear() &&
    value.getUTCMonth() === targetDate.getUTCMonth() &&
    value.getUTCDate() === targetDate.getUTCDate()
  );
}

async function addUpload({ filename, recipients }) {
  const upload = {
    uploadId: randomUUID(),
    filename,
    uploadedAt: new Date().toISOString(),
    totalRecipients: recipients.length,
    recipients,
  };

  await withData(async (data) => {
    data.uploads.push(upload);
  });

  return upload;
}

async function getUploadById(uploadId) {
  return readOnly((data) => deepClone(data.uploads.find((item) => item.uploadId === uploadId)));
}

async function getLatestUpload() {
  return readOnly((data) => {
    const upload = data.uploads[data.uploads.length - 1] || null;
    return deepClone(upload);
  });
}

async function createRun({ uploadId, subject, template, resumePath, resumeFilename, config, recipients }) {
  const now = new Date().toISOString();
  const run = {
    runId: randomUUID(),
    uploadId,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    status: "queued",
    subject,
    template,
    resumePath: resumePath || null,
    resumeFilename: resumeFilename || null,
    config,
    totalEmails: recipients.length,
    successCount: 0,
    failedCount: 0,
    processedCount: 0,
    pendingCount: recipients.length,
    batchSummary: [],
    groupSummary: [],
    records: recipients.map((recipient) => ({
      recipientId: recipient.id,
      name: recipient.name,
      email: recipient.email,
      company: recipient.company || "",
      group: recipient.group || "",
      batch: recipient.batch || "",
      batchKey: recipient.batchKey || "Batch 1",
      status: "queued",
      errorMessage: "",
      attempts: 0,
      timestamp: now,
    })),
  };

  recomputeStats(run);

  await withData(async (data) => {
    data.runs.push(run);
  });

  return deepClone(run);
}

async function updateRunStatus(runId, status) {
  await withData(async (data) => {
    const run = findRunById(data, runId);
    if (!run) return;
    if (status === "running" && !run.startedAt) {
      run.startedAt = new Date().toISOString();
    }
    if (run.status !== "completed") {
      run.status = status;
    }
    recomputeStats(run);
  });
}

async function updateRecord(runId, recipientId, patch) {
  await withData(async (data) => {
    const run = findRunById(data, runId);
    if (!run) return;
    const record = run.records.find((item) => item.recipientId === recipientId);
    if (!record) return;

    Object.assign(record, patch);
    if (!patch.timestamp) {
      record.timestamp = new Date().toISOString();
    }
    recomputeStats(run);
  });
}

async function markInProgress(runId, recipientId, attempts) {
  await updateRunStatus(runId, "running");
  await updateRecord(runId, recipientId, {
    status: "in_progress",
    attempts,
    errorMessage: "",
    timestamp: new Date().toISOString(),
  });
}

async function markSuccess(runId, recipientId, attempts) {
  await updateRunStatus(runId, "running");
  await updateRecord(runId, recipientId, {
    status: "success",
    attempts,
    errorMessage: "",
    timestamp: new Date().toISOString(),
  });
}

async function markFailure(runId, recipientId, errorMessage, attempts) {
  await updateRunStatus(runId, "running");
  await updateRecord(runId, recipientId, {
    status: "failed",
    attempts,
    errorMessage: errorMessage || "Unknown error",
    timestamp: new Date().toISOString(),
  });
}

async function getRunReport(runId) {
  return readOnly((data) => {
    const run = runId ? findRunById(data, runId) : data.runs[data.runs.length - 1] || null;
    return deepClone(run);
  });
}

async function getRunSummary(runId) {
  const run = await getRunReport(runId);
  if (!run) return null;

  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalEmails: run.totalEmails,
    sentSuccessfully: run.successCount,
    failed: run.failedCount,
    pending: run.pendingCount,
    processed: run.processedCount,
    batchSummary: run.batchSummary,
    groupSummary: run.groupSummary,
  };
}

async function getTodayQueuedEmailCount() {
  return readOnly((data) => {
    const now = new Date();
    return data.runs.reduce((sum, run) => {
      if (!run.createdAt) return sum;
      if (!isSameUtcDate(run.createdAt, now)) return sum;
      return sum + Number(run.totalEmails || 0);
    }, 0);
  });
}

async function markStaleInProgressAsFailed(staleMinutes) {
  const cutoffMs = Date.now() - Math.max(1, Number(staleMinutes || 10)) * 60 * 1000;

  await withData(async (data) => {
    data.runs.forEach((run) => {
      let changed = false;
      run.records.forEach((record) => {
        if (record.status !== "in_progress") return;
        const updatedMs = toMs(record.timestamp) || toMs(run.startedAt) || toMs(run.createdAt);
        if (!updatedMs || updatedMs > cutoffMs) return;

        record.status = "failed";
        record.errorMessage = "Processing timeout: worker/network stopped before completion.";
        record.timestamp = new Date().toISOString();
        changed = true;
      });

      if (changed) {
        recomputeStats(run);
      }
    });
  });
}

module.exports = {
  addUpload,
  getUploadById,
  getLatestUpload,
  createRun,
  getRunReport,
  getRunSummary,
  getTodayQueuedEmailCount,
  markStaleInProgressAsFailed,
  markInProgress,
  markSuccess,
  markFailure,
};
