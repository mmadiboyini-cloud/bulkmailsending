const { emailQueue } = require("../queue/mailQueue");
const env = require("../config/env");

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function randomIntBetween(min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

async function enqueueRunJobs({
  runId,
  subject,
  template,
  resumePath,
  resumeFilename,
  batches,
  batchDelaySeconds,
  perEmailMinDelaySeconds,
  perEmailMaxDelaySeconds,
  smtpConfig,
}) {
  const minSeconds = clampNumber(perEmailMinDelaySeconds, 2, 2, 5);
  const maxSeconds = clampNumber(perEmailMaxDelaySeconds, 5, 2, 5);
  const constrainedMin = clampNumber(minSeconds, 2, 2, 5);
  const constrainedMax = Math.max(constrainedMin, maxSeconds);
  const batchDelay = clampNumber(batchDelaySeconds, 60, 60, 300);

  let cumulativeDelayMs = 0;
  let queuedJobs = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    for (const recipient of batch.recipients) {
      const jitterMs = randomIntBetween(constrainedMin, constrainedMax) * 1000;
      cumulativeDelayMs += jitterMs;

      await emailQueue.add(
        "send-email",
        {
          runId,
          subject,
          template,
          resumePath: resumePath || null,
          resumeFilename: resumeFilename || null,
          smtp: smtpConfig,
          recipient,
        },
        {
          delay: cumulativeDelayMs,
          attempts: 3,
          timeout: env.emailJobTimeoutMs,
          backoff: {
            type: "fixed",
            delay: 15000,
          },
        }
      );

      queuedJobs += 1;
    }

    if (i < batches.length - 1) {
      cumulativeDelayMs += batchDelay * 1000;
    }
  }

  return {
    queuedJobs,
    estimatedScheduleSeconds: Math.floor(cumulativeDelayMs / 1000),
  };
}

module.exports = {
  enqueueRunJobs,
};
