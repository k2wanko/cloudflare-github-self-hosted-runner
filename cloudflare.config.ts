import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const runnerContainer = defineContainer({
  name: "runner",
  schedulingPolicy: "durable-object",
  images: { default: { dockerfile: "./images/default/Dockerfile" } },
});

export default defineConfig({
  worker: {
    name: process.env.CFRUNNER_WORKER_NAME ?? "cfrunner",
    compatibilityDate: "2026-09-25",
    entrypoint,
    env: {
      ALLOWED_OWNERS: bindings.text(process.env.ALLOWED_OWNERS ?? ""),
      LABEL_PREFIX: bindings.text(process.env.LABEL_PREFIX ?? "cfrunner"),
      SETUP_RESET_TOKEN: bindings.text(process.env.SETUP_RESET_TOKEN ?? ""),
    },
    exports: {
      Setup: exports.durableObject({ storage: "sqlite" }),
      RunnerJob: exports.durableObject({
        storage: "sqlite",
        container: runnerContainer,
      }),
    },
  },
  containers: [runnerContainer],
});
