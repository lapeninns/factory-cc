import { sendWorkerDecision } from "../src/workers/control.js";
import { pathToFileURL } from "node:url";

export async function workerControl(argv: string[]): Promise<void> {
  const [decision, ...args] = argv;
  if (decision !== "allow" && decision !== "deny") throw new Error("Use allow or deny with the exact pending worker action.");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !["--config", "--worker", "--approval", "--digest", "--summary"].includes(key) || !value || values.has(key)) throw new Error("Invalid worker decision arguments.");
    values.set(key, value);
  }
  for (const key of ["--config", "--worker", "--approval", "--digest", "--summary"]) if (!values.has(key)) throw new Error("All exact-action decision fields are required.");
  await sendWorkerDecision(values.get("--config")!, { id: values.get("--worker")!, approvalId: values.get("--approval")!, actionDigest: values.get("--digest")!, summary: values.get("--summary")!, decision });
  console.log(JSON.stringify({ ok: true, decision, workerId: values.get("--worker") }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  workerControl(process.argv.slice(2)).catch(() => { console.error("Worker decision refused; refresh its status and use the verified Factory approval path."); process.exitCode = 1; });
}
