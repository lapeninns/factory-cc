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
  it.each(['team1','team2','team3','team4','team5','team6','team7','team8'])('permits one fixed %s seat',subscriptionProfile=>{
    expect(readWorkerServerConfig(config({subscriptionProfile})).subscriptionProfile).toBe(subscriptionProfile);
  });
  it.each([{subscriptionProfile:'pool'},{subscriptionProfile:'team9'},{apiKeyFile:'/missing-api-secret'},{maxBudgetUsd:1},{approvalCommand:'/bin/approval-helper'}])('refuses mixed routes or model-callable approval %j',changes=>{
    expect(()=>readWorkerServerConfig(config(changes))).toThrow(/fixed Team profile/);
  });
  it('rejects API mode before reading any key or local service token',async()=>{
    const path=config({provider:'anthropic',subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1});
    await expect(runFactoryWorkers(['--config',path,'--check'],{subscriptionOnly:true})).rejects.toThrow(/subscription authentication only/);
  });
  it('requires an explicit owned-git policy to accept an empty registration list',()=>{
    expect(()=>readWorkerServerConfig(config({allowedRepositories:[]}))).toThrow(/allowlist/);
    expect(readWorkerServerConfig(config({repositoryPolicy:'owned-git',allowedRepositories:[]}))).toMatchObject({repositoryPolicy:'owned-git',allowedRepositories:[]});
    expect(readWorkerServerConfig(config({repositoryPolicy:'owned-git',allowedRepositories:['/missing/previous-repository']})).repositoryPolicy).toBe('owned-git');
  });
  it('supports explicit owned-workspace access for subscription folder snapshots',()=>{
    expect(readWorkerServerConfig(config({repositoryPolicy:'owned-workspace',allowedRepositories:[]}))).toMatchObject({repositoryPolicy:'owned-workspace',allowedRepositories:[]});
    expect(()=>readWorkerServerConfig(config({provider:'anthropic',repositoryPolicy:'owned-workspace',subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1}))).toThrow(/subscription authentication/);
  });
  it('bounds pending workspace admissions before allocating snapshots',()=>{
    expect(readWorkerServerConfig(config({maxPendingWorkers:8})).maxPendingWorkers).toBe(8);
    for(const maxPendingWorkers of [0,65,1.5,'8']) expect(()=>readWorkerServerConfig(config({maxPendingWorkers}))).toThrow(/Pending worker admission/);
  });
  it.each(['anywhere','',true,null])('rejects invalid private repository policy %j',repositoryPolicy=>{
    expect(()=>readWorkerServerConfig(config({repositoryPolicy}))).toThrow(/repository policy/);
  });
  it.each(['anthropic','openrouter'])('does not grant owned-git access to an API route: %s',provider=>{
    expect(()=>readWorkerServerConfig(config({provider,repositoryPolicy:'owned-git',subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1}))).toThrow(/subscription authentication/);
  });
  it('requires an explicit subscription-only approval bypass',()=>{
    expect(readWorkerServerConfig(config()).approvalPolicy).toBeUndefined();
    expect(readWorkerServerConfig(config({approvalPolicy:'ask'})).approvalPolicy).toBe('ask');
    expect(readWorkerServerConfig(config({approvalPolicy:'bypass'})).approvalPolicy).toBe('bypass');
    for(const approvalPolicy of ['',true,null,'always']) expect(()=>readWorkerServerConfig(config({approvalPolicy}))).toThrow(/approval/);
    for(const provider of ['anthropic','openrouter']) {
      expect(()=>readWorkerServerConfig(config({provider,subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1,approvalPolicy:'bypass'}))).toThrow(/subscription policy/);
      expect(readWorkerServerConfig(config({provider,subscriptionProfile:undefined,apiKeyFile:'/missing-api-secret',maxBudgetUsd:1,approvalPolicy:'ask'})).approvalPolicy).toBe('ask');
    }
  });
});
