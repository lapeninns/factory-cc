import type { BridgeConfig } from '../config.js';
import type { MessagesRequest } from '../types.js';
import { BridgeError } from '../types.js';
import { hostAllowsAnyTools } from './native-tool-policy.js';

/** Provider selection is explicit: generic BYOK routes never gain workflow authority. */
export function workflowProviderAllowed(config: BridgeConfig): boolean {
  if ((config.workflowProvider ?? "anthropic") === "anthropic") return config.authMode === "anthropic-api";
  if (config.workflowProvider !== "openrouter") return false;
  const model = config.models?.[0];
  return config.authMode === "byok"
    && config.upstreamBaseUrl === "https://openrouter.ai/api"
    && config.upstreamModel === "anthropic/claude-opus-5.5"
    && config.upstreamTokenEnv === "BRIDGE_OPENROUTER_API_KEY"
    && config.models?.length === 1 && model?.id === "claude-opus-5-5"
    && model.model === "anthropic/claude-opus-5.5" && model.provider !== "cursor" && !model.claudeProfile;
}

export function workflowAllowed(config: BridgeConfig, request: MessagesRequest | undefined, mode?: string): boolean {
  return config.nativeWorkflows === true && workflowProviderAllowed(config) && mode !== 'spec' && hostAllowsAnyTools(request);
}

/** Reject alternate script-loading and remote launch entry points. Inline script
 * semantics still require the native runtime's separate remote-dispatch guard. */
export function validateWorkflowInput(input: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Workflow input must be an object.";
  if (Object.keys(input).some(key => !['script', 'args'].includes(key))) return 'Only a local inline workflow script and literal args are supported.';
  if (typeof input.script !== 'string' || !input.script.trim()) return 'An inline workflow script is required.';
  return undefined;
}

interface Permit { id: string; name: string; input: string; epoch: number; claimed: boolean }
interface Waiting { permit: Permit; resolve(): void; reject(error: Error): void }
const canonical = (x: unknown): string => Array.isArray(x) ? '['+x.map(canonical).join(',')+']'
  : x !== null && typeof x === 'object' ? '{'+Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}' : JSON.stringify(x) ?? 'undefined';

/** One admitted host action per root query. Children may reason concurrently,
 * but no callback can borrow another child's tool-use identity. */
export class WorkflowPermits {
  private active?: Permit;
  private queue: Waiting[] = [];
  private seen = new Set<string>();
  private closed?: Error;
  get pending(): number { return this.queue.length + (this.active ? 1 : 0); }
  acquire(id: string | undefined, name: string, input: unknown, epoch: number): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (!id || this.seen.has(id)) return Promise.reject(new BridgeError(409, 'workflow_tool_identity', 'Missing or duplicate workflow tool-use identity'));
    this.seen.add(id);
    return new Promise((resolve,reject)=>{this.queue.push({permit:{id,name,input:canonical(input),epoch,claimed:false},resolve,reject});this.next();});
  }
  claim(name: string, input: unknown, epoch: number, id?: string): string {
    const p=this.active;
    if (!p || p.claimed || p.name!==name || p.input!==canonical(input) || p.epoch!==epoch || (id!==undefined && id!==p.id)) throw new BridgeError(409,'workflow_tool_identity','Callback does not match an admitted workflow action');
    p.claimed=true;
    return p.id;
  }
  release(id: string): void { if(this.active?.id===id){this.active=undefined;this.next();} }
  cancel(error: Error): void {this.closed=error;this.active=undefined;for(const q of this.queue)q.reject(error);this.queue=[];}
  private next(): void {if(!this.active && !this.closed){const q=this.queue.shift();if(q){this.active=q.permit;q.resolve();}}}
}
