import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { WorkflowPermits, validateWorkflowInput, workflowAllowed, workflowProviderAllowed } from '../../src/runtime/native-workflows.js';
import { SdkRuntime, type SdkHandle, type SdkUserInput } from '../../src/runtime/sdk-runtime.js';
import { MODEL_SLOT_NAMES } from '../../src/upstream/auth-env.js';
import type { RuntimeRequest } from '../../src/runtime/types.js';

vi.mock("../../src/runtime/native-workflow-support.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/runtime/native-workflow-support.js")>(),
  assertNativeWorkflowSupport: () => ({ executable: "/offline-fixture/claude" }),
}));

const runtimes: SdkRuntime[]=[];
const logger={info:vi.fn(),warn:vi.fn(),error:vi.fn()};
class Fake implements SdkHandle {
 calls: Array<{prompt:AsyncIterable<SdkUserInput>;options:Record<string,unknown>}>=[];
 handlers=new Map<string,(args:Record<string,unknown>,extra?:unknown)=>Promise<unknown>>();
 constructor(readonly respond:(fake:Fake)=>AsyncGenerator<Record<string,unknown>>){}
 tool(){return {};}
 createSdkMcpServer(options:Record<string,unknown>){return {...options,instance:{isConnected:()=>false,sendToolListChanged:async()=>{},server:{sendToolListChanged:async()=>{},setRequestHandler:()=>{}},registerTool:(name:string,_config:unknown,handler:(args:Record<string,unknown>,extra?:unknown)=>Promise<unknown>)=>{this.handlers.set(name,handler);return {update(){},remove(){}}}}};}
 query(args:{prompt:AsyncIterable<SdkUserInput>;options:Record<string,unknown>}) {
  this.calls.push(args);const self=this;
  return {accountInfo:async()=>({apiKeySource:'ANTHROPIC_API_KEY'}),interrupt:async()=>{},close(){},async *[Symbol.asyncIterator](){for await(const _ of args.prompt){yield {type:'system',subtype:'init',session_id:'root',apiKeySource:'ANTHROPIC_API_KEY'};yield* self.respond(self);}}};
 }
}
function setup(fake:Fake, extra={}){
 const c=loadConfig({mode:'sdk',authMode:'anthropic-api',desktopProfile:true,permissionMode:'ask',dataDir:mkdtempSync(join(tmpdir(),'workflow-test-')),nativeWorkflows:true,workflowMaxBudgetUsd:1,workflowMaxMs:1000,maxSessions:1,requestTimeoutMs:2000,toolWaitMs:2000,...extra});
 const runtime=new SdkRuntime(c,logger,fake);runtimes.push(runtime);return {runtime,c};
}
function request():RuntimeRequest{return {request:{model:'claude-opus-5-5',messages:[{role:'user',content:'test'}],max_tokens:10,tools:[{name:'Execute',input_schema:{type:'object',properties:{}}}]},session:{bridgeSessionId:'a',role:'chat',state:'NEW',model:'claude-opus-5-5',toolNames:[],createdAt:'',updatedAt:'',pendingToolIds:[],cancelRequested:false,notes:[],usage:{input_tokens:0,output_tokens:0,estimated:true}},role:'chat',headers:{}};}
const success=(text='done')=>({type:'result',subtype:'success',result:text,is_error:false,session_id:'root'});
beforeEach(()=>{vi.stubEnv('ANTHROPIC_API_KEY','offline-fixture-key');vi.stubEnv('BRIDGE_SDK_CWD',process.cwd());});
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(r=>r.close()));vi.unstubAllEnvs();});
it('serializes identical child calls and preserves exact ids',async()=>{
 const p=new WorkflowPermits();await p.acquire('a','mcp__droid__Read',{x:1},1);
 let admitted=false;const second=p.acquire('b','mcp__droid__Read',{x:1},1).then(()=>{admitted=true;});
 expect(p.claim('mcp__droid__Read',{x:1},1)).toBe('a');await Promise.resolve();expect(admitted).toBe(false);
 expect(()=>p.claim('mcp__droid__Read',{x:1},1)).toThrow();p.release('a');await second;expect(p.claim('mcp__droid__Read',{x:1},1,'b')).toBe('b');
});
it('rejects mismatched epochs, ids and missing hooks without borrowing a permit',async()=>{
 const p=new WorkflowPermits();expect(()=>p.claim('Read',{},1)).toThrow();await expect(p.acquire(undefined,'Read',{},1)).rejects.toThrow();await p.acquire('a','Read',{},1);
 expect(()=>p.claim('Read',{},2)).toThrow();expect(()=>p.claim('Read',{},1,'b')).toThrow();expect(()=>p.claim('Write',{},1)).toThrow();
});
it('cancellation rejects queued child actions and prevents late callbacks',async()=>{
 const p=new WorkflowPermits();await p.acquire('a','Read',{},1);const queued=p.acquire('b','Read',{},1);const rejected=expect(queued).rejects.toThrow('cancelled');p.cancel(Error('cancelled'));await rejected;expect(()=>p.claim('Read',{},1)).toThrow();await expect(p.acquire('c','Read',{},1)).rejects.toThrow();
});
it('allows only explicit API workflow authority outside spec with host tools',()=>{
 const fake=new Fake(async function*(){yield success();});const {c}=setup(fake);expect(workflowAllowed(c,request().request)).toBe(true);expect(workflowAllowed(c,request().request,'spec')).toBe(false);expect(workflowAllowed(c,{...request().request,tools:[]})).toBe(false);expect(workflowAllowed({...c,authMode:'subscription'},request().request)).toBe(false);
 for(const input of [{name:'x'},{scriptPath:'/tmp/x'},{script:'x',remote:true},{script:'x',resumeFromRunId:'x'}])expect(validateWorkflowInput(input)).toBeTruthy();expect(validateWorkflowInput({script:'inline',args:{x:1}})).toBeUndefined();
});
it('passes medium/API budget and workflow flags while retaining native side effect denial',async()=>{
 const fake=new Fake(async function*(){yield success();});const {runtime}=setup(fake);await runtime.handle(request());const options=fake.calls[0].options;
 expect(options.effort).toBe('medium');expect(options.maxBudgetUsd).toBe(1);expect(options.settings).toMatchObject({ultracode:true,enableWorkflows:true,workflowSizeGuideline:'small'});expect(options.settingSources).toEqual([]);
 expect(options.disallowedTools).toEqual(expect.arrayContaining(['Agent','Task','Bash','Write']));expect(options.disallowedTools).not.toContain('Workflow');
 const hook=(options.hooks as any).PreToolUse[0].hooks[0];expect(await hook({tool_name:'Bash',tool_input:{command:'bad'}})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
});
it('child messages cannot replace the root native resume identity',async()=>{
 const fake=new Fake(async function*(){yield {type:'assistant',session_id:'child',parent_tool_use_id:'workflow-a',message:{content:[{type:'text',text:'child'}]}};yield {...success('child result'),session_id:'child',parent_tool_use_id:'workflow-a'};yield success();});
 const {runtime}=setup(fake);expect((await runtime.handle(request())).sdkSessionId).toBe('root');
});
it('holds parent success until the tracked workflow completes',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const fake=new Fake(async function*(){yield {type:'system',subtype:'task_started',task_id:'child'};yield success('early');await gate;yield {type:'system',subtype:'task_notification',task_id:'child',status:'completed'};});
 const {runtime}=setup(fake);let finished=false;const result=runtime.handle(request()).then(r=>{finished=true;return r;});await new Promise(r=>setTimeout(r,25));expect(finished).toBe(false);release();expect((await result).response.stop_reason).toBe('end_turn');
});
it('fails the parent when a workflow task fails instead of reporting success',async()=>{
 const fake=new Fake(async function*(){yield {type:'system',subtype:'task_started',task_id:'child'};yield success('early');yield {type:'system',subtype:'task_notification',task_id:'child',status:'failed'};});const {runtime}=setup(fake);await expect(runtime.handle(request())).rejects.toMatchObject({code:'workflow_child_failed'});
});
it('requires approval for native workflow launch and rechecks spec authority',async()=>{
 const fake=new Fake(async function*(){yield success();});const {runtime}=setup(fake);let mode='auto';const approve=vi.fn(async()=>({behavior:'allow' as const}));runtime.setControl({requestApproval:approve,factoryPermissionMode:()=>mode});await runtime.handle(request());
 const callback=fake.calls[0].options.canUseTool as any;expect(await callback('Workflow',{script:'inline'})).toMatchObject({behavior:'allow'});expect(approve).toHaveBeenCalledTimes(1);mode='spec';expect(await callback('Workflow',{script:'inline'})).toMatchObject({behavior:'deny'});
});

function hook(fake:Fake): (input:Record<string,unknown>)=>Promise<any> { return (fake.calls[0].options.hooks as any).PreToolUse[0].hooks[0]; }
function answer(base:RuntimeRequest,id:string,text:string): RuntimeRequest { return {...base,request:{...base.request,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:id,content:text}]}]}}; }
it('keeps simultaneous child calls with identical arguments separate through actual MCP callbacks',async()=>{
 const received:unknown[]=[];
 const fake=new Fake(async function*(f){
  const run=async(id:string)=>{await hook(f)({tool_name:'mcp__droid__Execute',tool_use_id:id,tool_input:{}});received.push(await f.handlers.get('Execute')!({}));};
  await Promise.all([run('child-a'),run('child-b')]);yield success();
 });
 const {runtime}=setup(fake);const base=request();
 const a=await runtime.handle(base);expect(a.response.content).toContainEqual({type:'tool_use',id:'child-a',name:'Execute',input:{}});
 const b=await runtime.handle(answer(base,'child-a','result-a'));expect(b.response.content).toContainEqual({type:'tool_use',id:'child-b',name:'Execute',input:{}});
 expect((await runtime.handle(answer(base,'child-b','result-b'))).response.stop_reason).toBe('end_turn');
 expect(received).toEqual([{content:[{type:'text',text:'result-a'}],isError:false},{content:[{type:'text',text:'result-b'}],isError:false}]);
});
it('drains queued child hooks and active MCP callbacks when cancelled between HTTP turns',async()=>{
 const outcomes:unknown[]=[];let stopped!:()=>void;const done=new Promise<void>(r=>{stopped=r;});
 const fake=new Fake(async function*(f){
  const first=async()=>{await hook(f)({tool_name:'mcp__droid__Execute',tool_use_id:'active',tool_input:{}});return f.handlers.get('Execute')!({});};
  const active=first();
  const second=hook(f)({tool_name:'mcp__droid__Execute',tool_use_id:'queued',tool_input:{}});
  outcomes.push(...await Promise.allSettled([active,second]));stopped();yield success();
 });
 const {runtime}=setup(fake);await runtime.handle(request());await runtime.cancel('a','test cancellation');await done;
 expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({status:'rejected'}),expect.objectContaining({status:'fulfilled',value:expect.objectContaining({hookSpecificOutput:expect.objectContaining({permissionDecision:'deny'})})})]));
});
it('enforces one absolute workflow deadline across host tool HTTP roundtrips',async()=>{
 const fake=new Fake(async function*(f){
  await hook(f)({tool_name:'Workflow',tool_use_id:'workflow',tool_input:{script:"await agent('bounded')"}});
  await hook(f)({tool_name:'mcp__droid__Execute',tool_use_id:'round-one',tool_input:{}});await f.handlers.get('Execute')!({});
  await hook(f)({tool_name:'mcp__droid__Execute',tool_use_id:'round-two',tool_input:{}});await f.handlers.get('Execute')!({});yield success();
 });
 const {runtime}=setup(fake);runtime.setControl({requestApproval:async()=>({behavior:'allow'})});const base=request();await runtime.handle(base);await new Promise(r=>setTimeout(r,600));
 await runtime.handle(answer(base,'round-one','one'));await new Promise(r=>setTimeout(r,500));
 await expect(runtime.handle(answer(base,'round-two','two'))).rejects.toMatchObject({code:'workflow_deadline'});
});
it('fails root success if a child result reports failure',async()=>{
 const fake=new Fake(async function*(){yield {...success(),subtype:'error_during_execution',is_error:true,parent_tool_use_id:'workflow'};yield success();});
 const {runtime}=setup(fake);await expect(runtime.handle(request())).rejects.toMatchObject({code:'workflow_child_failed'});
});
it('preserves explicit Factory high effort',async()=>{
 const fake=new Fake(async function*(){yield success();});const {runtime}=setup(fake);const base=request();base.request.output_config={effort:'high'};await runtime.handle(base);expect(fake.calls[0].options.effort).toBe('high');
});

it('denies workflow launch with no tools, in spec mode, and when approved input adds a remote field',async()=>{
 const fake=new Fake(async function*(){yield success();});const {runtime}=setup(fake);let mode='spec';
 runtime.setControl({factoryPermissionMode:()=>mode,requestApproval:async()=>({behavior:'allow',updatedInput:{script:'x',remote:true}})});
 await runtime.handle(request());expect(await hook(fake)({tool_name:'Workflow',tool_use_id:'spec',tool_input:{script:'x'}})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
 mode='auto';expect(await (fake.calls[0].options.canUseTool as any)('Workflow',{script:'x'})).toMatchObject({behavior:'deny'});
 const noTools=new Fake(async function*(){yield success();});const separate=setup(noTools).runtime;const req=request();req.request.tools=[];await separate.handle(req);
 expect(await hook(noTools)({tool_name:'Workflow',tool_use_id:'none',tool_input:{script:'x'}})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
});

it('requires exactly one Factory approval in the launch hook even if native permissions would autoallow',async()=>{
 const fake=new Fake(async function*(){yield success();});const {runtime}=setup(fake);await runtime.handle(request());
 const input={tool_name:'Workflow',tool_use_id:'workflow',tool_input:{script:"await agent('bounded')"}};
 expect(await hook(fake)(input)).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
 const approve=vi.fn(async()=>({behavior:'allow' as const}));runtime.setControl({requestApproval:approve});
 expect(await hook(fake)(input)).toMatchObject({hookSpecificOutput:{permissionDecision:'allow',updatedInput:input.tool_input}});
 expect(approve).toHaveBeenCalledTimes(1);expect(approve).toHaveBeenCalledWith(expect.objectContaining({toolName:'Workflow',toolUseId:'workflow'}));
});

const openrouterConfig = {
 workflowProvider: 'openrouter' as const, authMode: 'byok' as const,
 upstreamBaseUrl: 'https://openrouter.ai/api', upstreamModel: 'anthropic/claude-opus-5.5', upstreamTokenEnv: 'BRIDGE_OPENROUTER_API_KEY',
};
it('admits only the exact explicitly selected OpenRouter workflow contract',()=>{
 vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('BRIDGE_OPENROUTER_API_KEY','offline-openrouter-fixture');
 const {c}=setup(new Fake(async function*(){yield success();}),openrouterConfig);
 expect(workflowProviderAllowed(c)).toBe(true);expect(workflowAllowed(c,request().request)).toBe(true);
 expect(workflowAllowed(c,request().request,'spec')).toBe(false);expect(workflowAllowed(c,{...request().request,tools:[]})).toBe(false);
 for(const changed of [
  {workflowProvider:undefined},{authMode:'anthropic-api' as const},{authMode:'subscription' as const},
  {upstreamBaseUrl:'https://openrouter.ai.evil.invalid/api'},{upstreamBaseUrl:'https://openrouter.ai/api/'},
  {upstreamModel:'anthropic/claude-sonnet-5.5'},{upstreamTokenEnv:'ANOTHER_API_KEY'},
  {models:[{id:'claude-opus-5-5',model:'different-model',displayName:'test'}]},
  {models:[{id:'claude-opus-5-5',model:'anthropic/claude-opus-5.5',displayName:'test',claudeProfile:'shared'}]},
 ]) expect(workflowProviderAllowed({...c,...changed})).toBe(false);
});
it('routes OpenRouter workflows through isolated BYOK auth with every model slot pinned',async()=>{
 vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('BRIDGE_OPENROUTER_API_KEY','offline-openrouter-fixture');
 const fake=new Fake(async function*(){yield success();});const {runtime,c}=setup(fake,openrouterConfig);
 vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN','offline-ambient-oauth');vi.stubEnv('ANTHROPIC_AUTH_TOKEN','offline-ambient-token');
 vi.stubEnv('CLAUDE_CONFIG_DIR','/offline/ambient-login');vi.stubEnv('CLAUDE_CODE_USE_BEDROCK','1');
 for(const name of MODEL_SLOT_NAMES) vi.stubEnv(name,'unwanted-ambient-model');
 await runtime.handle(request());const options=fake.calls[0].options;const env=options.env as Record<string,string>;
 expect(options.model).toBe('anthropic/claude-opus-5.5');expect(options.effort).toBe('medium');
 expect(options.maxBudgetUsd).toBe(1);expect(options.settings).toMatchObject({enableWorkflows:true,ultracode:true});
 expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');expect(env.ANTHROPIC_API_KEY).toBe('');
 expect(env.ANTHROPIC_AUTH_TOKEN).toBe('offline-openrouter-fixture');
 for(const name of MODEL_SLOT_NAMES) expect(env[name]).toBe('anthropic/claude-opus-5.5');
 for(const name of ['CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','BRIDGE_OPENROUTER_API_KEY']) expect(env).not.toHaveProperty(name);
 expect(env.CLAUDE_CONFIG_DIR).toBe(join(c.dataDir,'native-workflow-config'));expect(options.settingSources).toEqual([]);
 const approve=vi.fn(async()=>({behavior:'allow' as const}));runtime.setControl({requestApproval:approve});
 expect(await hook(fake)({tool_name:'Workflow',tool_use_id:'openrouter-workflow',tool_input:{script:"await agent('bounded')"}})).toMatchObject({hookSpecificOutput:{permissionDecision:'allow'}});
 expect(approve).toHaveBeenCalledTimes(1);
 expect(await hook(fake)({tool_name:'Bash',tool_input:{command:'false'}})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
});
it('rejects a mutated BYOK workflow route before starting the SDK',async()=>{
 vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('BRIDGE_OPENROUTER_API_KEY','offline-openrouter-fixture');
 const fake=new Fake(async function*(){yield success();});const {runtime,c}=setup(fake,openrouterConfig);
 c.upstreamBaseUrl='https://other-provider.invalid/api';
 await expect(runtime.handle(request())).rejects.toMatchObject({code:'workflow_provider_rejected'});expect(fake.calls).toHaveLength(0);
});
