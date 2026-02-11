// Trigger.dev Cloud – V.O.S. Inc. CRM workflow engine (v4)
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_jzideboaecnowkivvzxx",
  runtime: "node",
  logLevel: "log",
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["src/jobs"],
});
