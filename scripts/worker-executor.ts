import { createExecutorController } from "./factory-workers.js";
import { runWorkerExecutor } from "../src/workers/executor.js";

const requestPath = process.argv[2];
if (!requestPath || process.argv.length !== 3) throw new Error("Use the private worker executor request path.");
runWorkerExecutor(requestPath, createExecutorController).catch(() => {
  console.error("Worker executor ended before its operation settled. Inspect its private recorded state.");
  process.exitCode = 1;
});
