const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env = {
  port: Number(process.env.PORT || 5000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: String(process.env.SMTP_SECURE || "true") === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  dailyEmailLimit: Number(process.env.DAILY_EMAIL_LIMIT || 150),
  emailJobTimeoutMs: Number(process.env.EMAIL_JOB_TIMEOUT_MS || 120000),
  staleInProgressMinutes: Number(process.env.STALE_IN_PROGRESS_MINUTES || 10),
  smtpConnectionTimeoutMs: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
  smtpGreetingTimeoutMs: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 30000),
  smtpSocketTimeoutMs: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 120000),
};

module.exports = env;
