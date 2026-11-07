import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readWorkerServerConfig } from "./factory-workers.js";
import { readPoolConfig } from "../src/workers/pool.js";
import { readWorkers } from "../src/workers/worker-state.js";
import { workerExecutorStatus } from "../src/workers/executor.js";
import { prepareSubscription, subscriptionFailureReport } from "../src/workers/subscription-auth.js";
import { SUBSCRIPTION_WORKER_SLOTS } from "../src/runtime/desktop-jobs.js";

/** Candidate diagnostics only: no daemon construction, state writes, model prompts or starts. */
export async function subscriptionDoctor(configFile: string) {
  const pool = readPoolConfig(configFile);
  const accounts = await Promise.all(pool.seats.map(async seat => {
    try {
      const config = readWorkerServerConfig(seat.configFile);
      if (config.provider !== "subscription" || config.subscriptionProfile !== seat.profile) throw new Error();
      const prepared = await prepareSubscription(seat.profile, { mappingPath: config.profileMappingPath });
      const workers = readWorkers(config.stateRoot);
      const unsettled = workers.filter(worker => !["completed", "failed", "cancelled"].includes(worker.state) || worker.leaseReleased === false);
      const observations = unsettled.map(worker => {
        const view = workerExecutorStatus(config.stateRoot, worker.id, { sharedStateRoot: config.sharedStateRoot });
        return { id: worker.id, state: view?.state ?? "unknown", cleanupVerified: view?.cleanupVerified ?? null,
          leaseReleased: view?.leaseReleased ?? false, reconciled: view?.reason === "shared_lease_settlement_reconciled" };
      });
      return { profile: seat.profile, loginVerified: true, runtime: { cliVersion: prepared.runtime.cliVersion, sdkVersion: prepared.runtime.sdkVersion },
        enabled: config.enabled, approvalGuardVerified: config.approvalGuardVerified,
        recoveryRequired: observations.some(view => view.state === "unknown"), observations };
    } catch (error) {
      return { profile: seat.profile, loginVerified: false, ...subscriptionFailureReport(error) };
    }
  }));
  return { checkedAt: new Date().toISOString(), scope: "candidate_preflight_and_saved_execution_evidence",
    modelRequestsMade: false, liveServicesChanged: false, remainingProviderAllowance: "unknown",
    policy: { workerSlots: SUBSCRIPTION_WORKER_SLOTS, perSeatExecuting: 1, controllerSlots: 1, weightMeaning: "assignment_priority" }, accounts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") {
    console.error("Use --config /absolute/private/pool-config.json. This command is read-only and sends no model prompt.");
    process.exitCode = 1;
  } else {
    subscriptionDoctor(process.argv[3]!).then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (report.accounts.some(account => !account.loginVerified || ("recoveryRequired" in account && (account.recoveryRequired || !account.enabled || !account.approvalGuardVerified)))) process.exitCode = 1;
    }).catch(error => { console.error(JSON.stringify(subscriptionFailureReport(error))); process.exitCode = 1; });
  }
}
