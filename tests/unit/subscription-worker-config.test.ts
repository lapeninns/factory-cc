import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkerServerConfig, runFactoryWorkers } from '../../scripts/factory-workers.js';
const roots: string[] = [];
function config(changes: Record<string, unknown> = {}) {
  const root=mkdtempSync(join(tmpdir(),'sub-config-')); roots.push(root);
  const path=join(root,'config.json');
  writeFileSync(path,JSON.stringify({enabled:false,provider:'subscription',subscriptionProfile:'team1',stateRoot:root,workspaceRoot:root,allowedRepositories:[root],nativeRuntimePath:root,sharedStateRoot:root,port:18791,clientTokenFile:join(root,'token'),approvalGuardVerified:false,maxMs:1000,maxTurns:1,...changes}),{mode:0o600});
  return path;
}
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
describe('subscription-only worker entry point',()=>{
  it.each(['team1','team2','team3','team4'])('permits one fixed %s seat',subscriptionProfile=>{
    expect(readWorkerServerConfig(config({subscriptionProfile})).subscriptionProfile).toBe(subscriptionProfile);
  });
  it.each([{subscriptionProfile:'pool'},{subscriptionProfile:'team5'},{apiKeyFile:'/missing-api-secret'},{maxBudgetUsd:1},{approvalCommand:'/bin/approval-helper'}])('refuses mixed routes or model-callable approval %j',changes=>{
    expect(()=>readWorkerServerConfig(config(changes))).toThrow(/fixed Team profile/);
  });
  it('rejects API mode before reading any key or local service token',async()=>{
    const path=config({provider:'anthropic',subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1});
    await expect(runFactoryWorkers(['--config',path,'--check'],{subscriptionOnly:true})).rejects.toThrow(/subscription authentication only/);
  });
});
