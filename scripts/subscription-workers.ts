import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runFactoryWorkers } from "./factory-workers.js";

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runFactoryWorkers(process.argv.slice(2), { subscriptionOnly: true }).catch(() => {
    console.error("Subscription worker service could not start. Check its fixed Team profile, private configuration and permission setup. API fallback is disabled.");
    process.exitCode = 1;
  });
}
