import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlBroker } from '../../src/control/broker.js';
import { SessionStore } from '../../src/sessions/store.js';
import { loadConfig, type BridgeConfig } from '../../src/config.js';
import type { BridgeRuntime } from '../../src/runtime/types.js';
import type { MessagesRequest } from '../../src/types.js';
const roots: string[]=[];
function root(){const p=realpathSync(mkdtempSync(join(tmpdir(),'legacy-marker-')));roots.push(p);return p;}
beforeEach(()=>{for(const k of Object.keys(process.env))if(/^(BRIDGE_|ANTHROPIC_|CLAUDE_|OPENROUTER_)/.test(k))vi.stubEnv(k,undefined);});
afterEach(()=>{vi.unstubAllEnvs();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(ignore=false){
 const cwd=root();const runtime:BridgeRuntime={kind:'sdk',handle:vi.fn(),deliverResults:vi.fn(),cancel:vi.fn(async()=>{}),endHostSession:vi.fn(async()=>({resumable:true}))};
 const broker=new ControlBroker(runtime,new SessionStore(join(cwd,'state'),false,16),1000,{ignoreUnknownSessionMarkers:ignore});
 const event=(hook='SessionStart',session_id='legacy')=>({hook_event_name:hook,session_id,cwd});
 return {cwd,broker,event};
}
function request(content:string):MessagesRequest{return {model:'test',max_tokens:10,messages:[{role:'user',content}]};}
function config(extra:Partial<BridgeConfig>={}){const cwd=root();return loadConfig({authMode:'claude-config',dataDir:join(cwd,'data'),sdkCwd:cwd,desktopProfile:true,desktopJobs:false,desktopLifecycle:false,claudeConfig:{path:'/fixture/settings.json',env:{},literalNames:[],ignored:[],credentialSource:'native-login'},...extra});}
it('keeps unknown markers rejected by default',()=>{
 const f=fixture();expect(()=>f.broker.prepareRequest(request('[factory-cc-session:'+ 'a'.repeat(64)+'] task'),f.cwd)).toThrowError(expect.objectContaining({code:'stale_host_binding'}));
});
it('removes only unknown foreign marker metadata for the explicit legacy path',()=>{
 const f=fixture(true);const prepared=f.broker.prepareRequest(request('[factory-cc-session:'+ 'a'.repeat(64)+'] task'),f.cwd);
 expect(prepared.binding).toBeUndefined();expect(prepared.request.messages[0]!.content).toBe(' task');
 expect(f.broker.describe()).toMatchObject({ignoreUnknownSessionMarkers:true});
});
it('still rejects a recognized ended generation when compatibility is enabled',async()=>{
 const f=fixture(true);const start=await f.broker.hostEvent({eventId:randomUUID(),event:f.event()});
 await f.broker.hostEvent({eventId:randomUUID(),event:f.event('SessionEnd'),bindingToken:start.bindingToken});
 expect(()=>f.broker.prepareRequest(request(start.additionalContext+' task'),f.cwd)).toThrowError(expect.objectContaining({code:'stale_host_binding'}));
});
it('binds a live own marker amid foreign markers and strips all marker secrets',async()=>{
 const f=fixture(true);const start=await f.broker.hostEvent({eventId:randomUUID(),event:f.event()});
 const prepared=f.broker.prepareRequest(request('[factory-cc-session:'+ 'a'.repeat(64)+']'+start.additionalContext+' task'),f.cwd);
 expect(prepared.binding).toBe(start.bindingToken);expect(prepared.request.messages[0]!.content).toBe(' task');
 expect(()=>f.broker.prepareRequest(request(start.additionalContext+' task'),f.cwd+'-wrong')).toThrowError(expect.objectContaining({code:'host_workspace_mismatch'}));
});
it('retains the ambiguous-own-host guard',async()=>{
 const f=fixture(true);const a=await f.broker.hostEvent({eventId:randomUUID(),event:f.event()});
 const b=await f.broker.hostEvent({eventId:randomUUID(),event:f.event('SessionStart','second')});
 expect(()=>f.broker.prepareRequest(request(String(a.additionalContext)+b.additionalContext),f.cwd)).toThrowError(expect.objectContaining({code:'ambiguous_host_binding'}));
});
it('requires the explicit opt-in and restricts it to the legacy claude-config route',()=>{
 expect(config().ignoreUnknownSessionMarkers).toBe(false);
 expect(config({ignoreUnknownSessionMarkers:true}).ignoreUnknownSessionMarkers).toBe(true);
 for(const extra of [{authMode:'subscription'},{authMode:'byok'},{desktopJobs:true},{desktopLifecycle:true}] as Partial<BridgeConfig>[])
  expect(()=>config({...extra,ignoreUnknownSessionMarkers:true})).toThrow(/restricted to legacy/);
 vi.stubEnv('BRIDGE_IGNORE_UNKNOWN_SESSION_MARKERS','1');expect(config().ignoreUnknownSessionMarkers).toBe(true);
 vi.stubEnv('BRIDGE_IGNORE_UNKNOWN_SESSION_MARKERS','yes');expect(()=>config()).toThrow(/must be 0 or 1/);
});
