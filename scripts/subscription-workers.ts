import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { subscriptionFailureReport } from "../src/workers/subscription-auth.js";
import { runFactoryWorkers } from "./factory-workers.js";

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runFactoryWorkers(process.argv.slice(2), { subscriptionOnly: true }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "worker_startup_failed", ...subscriptionFailureReport(error), apiFallback: false }));
    process.exitCode = 1;
  });
}
