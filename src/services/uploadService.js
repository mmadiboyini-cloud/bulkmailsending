const xlsx = require("xlsx");
const { randomUUID } = require("crypto");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeRow(row) {
  return Object.entries(row || {}).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || "").trim().toLowerCase();
    acc[normalizedKey] = String(value ?? "").trim();
    return acc;
  }, {});
}

function parseRecipients(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(firstSheet, { defval: "" });

  const recipients = [];
  const invalidRows = [];

  rows.forEach((row, index) => {
    const normalized = normalizeRow(row);
    const name = normalized.name || "";
    const email = normalized.email || "";
    const company = normalized.company || "";
    const group = normalized.group || "";
    const batch = normalized.batch || "";

    if (!name || !email || !EMAIL_REGEX.test(email)) {
      invalidRows.push({
        rowNumber: index + 2,
        reason: "Missing/invalid name or email",
      });
      return;
    }

    recipients.push({
      id: randomUUID(),
      name,
      email,
      company,
      group,
      batch,
    });
  });

  return { recipients, invalidRows };
}

module.exports = {
  parseRecipients,
};

