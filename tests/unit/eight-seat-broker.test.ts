import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ControlBroker } from '../../src/control/broker.js';
import { SessionStore } from '../../src/sessions/store.js';
import type { BridgeRuntime } from '../../src/runtime/types.js';
import type { MessagesRequest } from '../../src/types.js';

it('eight controllers bind only their own marker and never borrow another live seat marker', async () => {
 const cwd=realpathSync(mkdtempSync(join(tmpdir(),'eight-seat-brokers-')));
 try {
  const controllers=Array.from({length:8},(_,index)=>{
   const runtime: BridgeRuntime={kind:'sdk',handle:vi.fn(),deliverResults:vi.fn(),cancel:vi.fn(async()=>{}),endHostSession:vi.fn(async()=>({resumable:true}))};
   return new ControlBroker(runtime,new SessionStore(join(cwd,String(index)),false,16),1000,{desktopLifecycle:true});
  });
  const starts=await Promise.all(controllers.map(b=>b.hostEvent({eventId:randomUUID(),event:{hook_event_name:'SessionStart',session_id:'same-factory-workstream',cwd},desktopLifecycle:true})));
  expect(new Set(starts.map(x=>x.bindingToken)).size).toBe(8);
  const request:MessagesRequest={model:'claude-opus-5-5',max_tokens:16,messages:[{role:'user',content:starts.map(x=>x.additionalContext).join('\n')+'\nDo the task.'}]};
  controllers.forEach((b,index)=>{
   const prepared=b.prepareRequest(request,cwd);
   expect(prepared.binding).toBe(starts[index]!.bindingToken);
   expect(JSON.stringify(prepared.request)).not.toContain('factory-cc-session:');
   for(const start of starts)expect(JSON.stringify(prepared.request)).not.toContain(start.bindingToken);
  });
  await controllers[7]!.hostEvent({eventId:randomUUID(),event:{hook_event_name:'SessionEnd',session_id:'same-factory-workstream',cwd},bindingToken:starts[7]!.bindingToken});
  expect(()=>controllers[7]!.prepareRequest(request,cwd)).toThrowError(expect.objectContaining({code:'stale_host_binding'}));
  expect(controllers[0]!.prepareRequest(request,cwd).binding).toBe(starts[0]!.bindingToken);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
