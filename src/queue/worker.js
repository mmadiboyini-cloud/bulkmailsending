const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const env = require("../config/env");
const { renderTemplate } = require("../services/templateService");
const { markInProgress, markSuccess, markFailure } = require("../services/reportService");
const { emailQueue } = require("./mailQueue");

let started = false;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTemplateToHtml(template) {
  const raw = String(template || "");
  if (!raw.trim()) return "";
  const hasHtmlTags = /<\s*[a-z][\s\S]*>/i.test(raw);
  if (hasHtmlTags) {
    return raw;
  }
  return escapeHtml(raw).replace(/\r?\n/g, "<br/>");
}

function hasHtmlTags(value) {
  return /<\s*[a-z][\s\S]*>/i.test(String(value || ""));
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveSmtpConfig(rawConfig) {
  return {
    host: String(rawConfig?.host || env.smtpHost || "").trim(),
    port: Number(rawConfig?.port || env.smtpPort || 465),
    secure: typeof rawConfig?.secure === "boolean" ? rawConfig.secure : env.smtpSecure,
    user: String(rawConfig?.user || env.smtpUser || "").trim(),
    pass: String(rawConfig?.pass || env.smtpPass || "").trim(),
    from: String(rawConfig?.from || env.smtpFrom || rawConfig?.user || env.smtpUser || "").trim(),
  };
}

function buildTransporter(smtp) {
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error("SMTP is not configured. Update backend/.env SMTP_* values.");
  }

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: env.smtpConnectionTimeoutMs,
    greetingTimeout: env.smtpGreetingTimeoutMs,
    socketTimeout: env.smtpSocketTimeoutMs,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });
}

async function sendEmail(transporter, smtp, jobData) {
  const { recipient, subject, template, resumePath, resumeFilename } = jobData;
  const personalizedTemplate = renderTemplate(template, recipient);
  const containsHtml = hasHtmlTags(personalizedTemplate);
  const personalizedHtml = normalizeTemplateToHtml(personalizedTemplate);
  const personalizedText = htmlToText(personalizedHtml);

  const attachments = [];
  if (resumePath && fs.existsSync(resumePath)) {
    attachments.push({
      path: resumePath,
      filename: resumeFilename || path.basename(resumePath),
    });
  }

  const message = {
    from: smtp.from || smtp.user,
    to: recipient.email,
    subject,
    attachments,
  };

  if (containsHtml) {
    message.html = personalizedHtml;
  } else {
    message.text = personalizedText;
    message.html = personalizedHtml;
  }

  await transporter.sendMail(message);
}

function startQueueWorker() {
  if (started) return;
  started = true;

  emailQueue.process("send-email", 1, async (job) => {
    const { runId, recipient } = job.data;
    const attempts = job.attemptsMade + 1;
    const maxAttempts = Number(job?.opts?.attempts || 1);

    try {
      await markInProgress(runId, recipient.id, attempts);

      const smtp = resolveSmtpConfig(job.data.smtp);
      const transporter = buildTransporter(smtp);
      await sendEmail(transporter, smtp, job.data);

      await markSuccess(runId, recipient.id, attempts);
      return { ok: true };
    } catch (error) {
      if (attempts >= maxAttempts) {
        await markFailure(runId, recipient.id, error?.message || "Email send failed", attempts);
      }
      throw error;
    }
  });

  emailQueue.on("failed", async (job, error) => {
    const maxAttempts = Number(job?.opts?.attempts || 1);
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    const runId = job?.data?.runId;
    const recipientId = job?.data?.recipient?.id;
    if (!runId || !recipientId) return;

    await markFailure(runId, recipientId, error?.message || "Email send failed", job.attemptsMade);
  });
}

module.exports = {
  startQueueWorker,
};
