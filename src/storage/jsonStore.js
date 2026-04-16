const fs = require("fs");
const path = require("path");

const dataPath = path.resolve(__dirname, "../../data/state.json");
const defaultState = { uploads: [], runs: [] };
let mutationQueue = Promise.resolve();
const RETRYABLE_WRITE_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStore() {
  await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
  if (!fs.existsSync(dataPath)) {
    await fs.promises.writeFile(dataPath, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

async function readData() {
  await ensureStore();
  const raw = await fs.promises.readFile(dataPath, "utf8");
  if (!raw.trim()) {
    return { ...defaultState };
  }
  return JSON.parse(raw);
}

async function writeData(data) {
  const payload = JSON.stringify(data, null, 2);
  let lastError = null;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const tempPath = `${dataPath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, payload, "utf8");
      await fs.promises.rename(tempPath, dataPath);
      return;
    } catch (error) {
      lastError = error;
      await fs.promises.unlink(tempPath).catch(() => {});

      if (!RETRYABLE_WRITE_ERRORS.has(error?.code) || attempt === 6) {
        break;
      }

      await delay(attempt * 40);
    }
  }

  try {
    await fs.promises.writeFile(dataPath, payload, "utf8");
    return;
  } catch (fallbackError) {
    throw fallbackError || lastError;
  }
}

function withData(mutator) {
  const task = mutationQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await writeData(data);
    return result;
  });

  mutationQueue = task.catch(() => {});
  return task;
}

async function readOnly(selector) {
  const data = await readData();
  if (typeof selector === "function") {
    return selector(data);
  }
  return data;
}

module.exports = {
  withData,
  readOnly,
};
