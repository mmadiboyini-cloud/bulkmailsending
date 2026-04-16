function splitIntoChunks(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function resolveBatchColumn(recipients, requestedColumn) {
  const normalized = String(requestedColumn || "").trim().toLowerCase();
  if (normalized && ["batch", "group"].includes(normalized)) {
    return normalized;
  }

  const hasBatch = recipients.some((item) => item.batch);
  if (hasBatch) return "batch";

  const hasGroup = recipients.some((item) => item.group);
  if (hasGroup) return "group";

  return "batch";
}

function parseBatchSequence(batchSequence) {
  if (!batchSequence) return [];
  return String(batchSequence)
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildManualBatches(recipients, batchSize, batchSequence) {
  const sequence = parseBatchSequence(batchSequence);
  if (sequence.length > 0) {
    const batches = [];
    let cursor = 0;

    sequence.forEach((size, index) => {
      if (cursor >= recipients.length) return;
      const chunk = recipients.slice(cursor, cursor + size);
      cursor += size;
      batches.push({
        batchKey: `Batch ${index + 1}`,
        recipients: chunk,
      });
    });

    if (cursor < recipients.length) {
      batches.push({
        batchKey: `Batch ${batches.length + 1}`,
        recipients: recipients.slice(cursor),
      });
    }

    return batches;
  }

  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 10;
  return splitIntoChunks(recipients, size).map((chunk, index) => ({
    batchKey: `Batch ${index + 1}`,
    recipients: chunk,
  }));
}

function buildColumnBatches(recipients, batchColumn) {
  const groups = new Map();
  recipients.forEach((recipient) => {
    const value = String(recipient[batchColumn] || "Unassigned").trim() || "Unassigned";
    if (!groups.has(value)) {
      groups.set(value, []);
    }
    groups.get(value).push(recipient);
  });

  return Array.from(groups.entries()).map(([value, items], index) => ({
    batchKey: `Batch ${index + 1} (${batchColumn}: ${value})`,
    recipients: items,
  }));
}

function buildBatches(recipients, config) {
  const batchMode = config.batchMode === "column" ? "column" : "manual";
  const batchColumn = resolveBatchColumn(recipients, config.batchColumn);

  if (batchMode === "column") {
    return {
      batches: buildColumnBatches(recipients, batchColumn),
      resolvedBatchMode: "column",
      resolvedBatchColumn: batchColumn,
    };
  }

  return {
    batches: buildManualBatches(recipients, Number(config.batchSize), config.batchSequence),
    resolvedBatchMode: "manual",
    resolvedBatchColumn: batchColumn,
  };
}

module.exports = {
  buildBatches,
};
