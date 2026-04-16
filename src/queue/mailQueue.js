const Bull = require("bull");
const env = require("../config/env");

const emailQueue = new Bull("bulk-email-queue", env.redisUrl, {
  defaultJobOptions: {
    removeOnComplete: 2000,
    removeOnFail: 2000,
  },
});

module.exports = {
  emailQueue,
};

