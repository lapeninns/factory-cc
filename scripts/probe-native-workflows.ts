import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, createSdkMcpServer, tool, type Options, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { assertNativeWorkflowSupport } from '../src/runtime/native-workflow-support.js';
import { OwnedProcesses, processTable } from '../src/runtime/owned-processes.js';
import { WorkflowPermits } from '../src/runtime/native-workflows.js';
import { DESKTOP_DISALLOWED_TOOLS } from '../src/runtime/desktop-policy.js';

// Offline protocol fixture. Never inherit credentials or contact a paid provider.
const root = resolve(process.env.BRIDGE_WORKFLOW_PROBE_DIR ?? `tmp/native-workflow-probe-${Date.now()}`);
mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
mkdirSync(root, { mode: 0o700 });
const home = join(root, 'home'), configDir = join(root, 'claude-config');
for (const p of [home, configDir]) mkdirSync(p, { mode: 0o700 });
const support = assertNativeWorkflowSupport();
const pids = new Set<number>();
const processEvents: unknown[] = [];
const owners = new OwnedProcesses({ info(event, data) { processEvents.push({ event, data }); if (typeof data?.pid === 'number') pids.add(data.pid); }, warn(event, data) { processEvents.push({ event, data }); }, error(event, data) { processEvents.push({ event, data }); } });
let scenario: 'local' | 'remote' = 'local';
let requests = 0;
const requestsSeen: any[] = [], hooks: any[] = [], callbacks: any[] = [], sdkEvents: any[] = [];
const permits = new WorkflowPermits();
const workflowScripts = {
  local: `export const meta = { name: 'local-probe', description: 'Offline workflow probe', phases: ['probe'] }; const results = await parallel([() => agent('LOCAL_CHILD_ALPHA'), () => agent('LOCAL_CHILD_BETA')]); console.log(JSON.stringify(results));`,
  remote: `export const meta = { name: 'remote-probe', description: 'Offline remote rejection probe', phases: ['probe'] }; const opts = {}; opts[['iso','lation'].join('')] = ['re','mote'].join(''); const result = await agent('REMOTE_PROBE_CHILD', opts); console.log(result);`,
};
const gateway = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
    const body = JSON.parse(raw); requests++;
    const messages = body.messages ?? [];
    const firstUser = messages.find((m: any) => m.role === 'user');
    const first = JSON.stringify(firstUser?.content ?? '');
    const child = first.includes('LOCAL_CHILD_ALPHA') ? 'alpha' : first.includes('LOCAL_CHILD_BETA') ? 'beta' : first.includes('REMOTE_PROBE_CHILD') ? 'remote-child' : undefined;
    const hasResult = messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
    const tools = (body.tools ?? []).map((t: any) => t.name);
    requestsSeen.push({ request: requests, scenario, child, hasResult, model: body.model, effort: body.output_config?.effort, tools, messages });
    if (!hasResult) assert(tools.includes(child ? 'mcp__probe__Echo' : 'Workflow'), 'The native engine did not advertise the tool required by this fixture.');
    let content: any;
    if (!hasResult && child) content = { type: 'tool_use', id: `tool-child-${child}`, name: 'mcp__probe__Echo', input: { value: 'identical-input' } };
    else if (!hasResult) content = { type: 'tool_use', id: `workflow-${scenario}`, name: 'Workflow', input: { script: workflowScripts[scenario] } };
    else content = { type: 'text', text: child ? `CHILD_DONE_${child}` : 'ROOT_DONE' };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { id: `msg_${requests}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  } catch { res.writeHead(500); res.end('local-fixture-error'); }
});
await new Promise<void>((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done); });
const address = gateway.address(); assert(address && typeof address === 'object');
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_API_KEY: 'offline-fixture-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
};
const server = createSdkMcpServer({ name: 'probe', version: '1', tools: [tool('Echo', 'Offline identity probe', { value: z.string() }, async (args, extra) => {
  const explicit = (extra as any)?.toolUseId ?? (extra as any)?.tool_use_id;
  const id = permits.claim('mcp__probe__Echo', args, 1, explicit);
  callbacks.push({ id, args, extraKeys: Object.keys(extra ?? {}) });
  await new Promise(done => setTimeout(done, 50)); permits.release(id);
  return { content: [{ type: 'text', text: `RESULT_FOR_${id}` }] };
})] });
const cases: unknown[] = [];
try {
  for (const name of ['local', 'remote'] as const) {
    scenario = name;
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 45_000);
    const options: Options = {
      pathToClaudeCodeExecutable: support.executable, env, cwd: root, settingSources: [], strictMcpConfig: true,
      persistSession: false, model: 'claude-opus-5-5', effort: 'medium', maxTurns: 8, maxBudgetUsd: 0.1,
      permissionMode: 'default', tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Offline protocol test. Execute the supplied native workflow.' },
      settings: { enableWorkflows: true, ultracode: true, workflowSizeGuideline: 'small' } as any,
      allowedTools: ['mcp__probe__*'], disallowedTools: DESKTOP_DISALLOWED_TOOLS.filter(name => name !== 'Workflow'), mcpServers: { probe: server },
      abortController: abort,
      spawnClaudeCodeProcess: opts => owners.spawn(randomUUID(), opts) as SpawnedProcess,
      canUseTool: async (toolName, input) => toolName === 'Workflow' || toolName === 'mcp__probe__Echo' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Offline fixture denies all other tools' },
      hooks: { PreToolUse: [{ hooks: [async input => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        hooks.push({ scenario, name: input.tool_name, id: input.tool_use_id, input: input.tool_input });
        if (input.tool_name === 'mcp__probe__Echo') await permits.acquire(input.tool_use_id, input.tool_name, input.tool_input, 1);
        return {};
      }] }] },
    };
    let error: string | undefined;
    try { for await (const event of query({ prompt: `ROOT_${name.toUpperCase()}_PROBE`, options })) sdkEvents.push({ scenario, event }); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { clearTimeout(timeout); abort.abort(); }
    cases.push({ name, error, requests });
  }
} finally {
  await owners.close(); gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done()));
  const table = await processTable();
  const leaked = [...pids].filter(pid => table.has(pid) && !table.get(pid)!.state.startsWith('Z'));
  const localCompleted = sdkEvents.some(x => x.scenario === 'local' && x.event.subtype === 'task_notification' && x.event.status === 'completed');
  const remoteRejected = sdkEvents.some(x => x.scenario === 'remote' && x.event.subtype === 'task_notification' && x.event.status === 'failed' && x.event.summary?.includes("agent({isolation:'remote'}) is not available in this build"));
  const expected = ['tool-child-alpha', 'tool-child-beta'];
  const identityPassed = callbacks.length === 2 && expected.every(id => callbacks.filter(x => x.id === id && x.args.value === 'identical-input').length === 1)
    && expected.every(id => hooks.some(x => x.id === id && x.name === 'mcp__probe__Echo'))
    && ['alpha', 'beta'].every(child => requestsSeen.some(x => x.child === child && x.hasResult && JSON.stringify(x.messages).includes(`RESULT_FOR_tool-child-${child}`)));
  const noRemoteChildRequest = !requestsSeen.some(x => x.child === 'remote-child');
  const mediumOpusRequests = requestsSeen.every(x => x.model === 'claude-opus-5-5' && x.effort === 'medium');
  const checks = { localCompleted, identityPassed, remoteRejected, noRemoteChildRequest, mediumOpusRequests, noProcessLeak: leaked.length === 0 };
  const report = { checks, support, provider: 'loopback fixture only', realKeysUsed: false, cases, requests, hooks, callbacks, leakedProcesses: leaked.length, processEvents, requestsSeen, sdkEvents };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ root, checks, requests, cases, hooks: hooks.length, callbacks, leakedProcesses: leaked.length }));
  for (const [name, passed] of Object.entries(checks)) assert(passed, `Native workflow probe failed: ${name}; see ${join(root, 'report.json')}`);
}
