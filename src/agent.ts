/**
 * AgentRunner: one Durable Object per agent. An alarm-driven loop that claims a
 * change, clones its strand, produces an edit (Workers AI or a deterministic
 * synthetic edit), commits, pushes with the lease token and submits. It never
 * talks to trunk: the Integrator does that.
 */
import { DurableObject } from "cloudflare:workers";
import type { AgentKind, Change } from "./types";
import { BRANCH } from "./types";
import { clone, commitFiles, push, type Workspace } from "./git";
import { inScope } from "./artifacts";
import { chat, extractJson, editMessages, EDIT_MODEL, type EditResult } from "./llm";

interface RunnerState {
  agent: string;
  kind: AgentKind;
  model: string | null;
  maxChanges: number;
  done: number;
  running: boolean;
  idlePolls: number;
  errors: number;
  lease: number;
  lastError?: string;
}

const CONTEXT_FILES = ["site.json", "README.md"];

export class AgentRunner extends DurableObject<Env> {
  private coord() {
    return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("main"));
  }

  async start(opts: { agent: string; kind: AgentKind; model?: string | null; maxChanges?: number; stagger?: number }) {
    const st: RunnerState = {
      agent: opts.agent,
      kind: opts.kind,
      model: opts.kind === "llm" ? opts.model ?? EDIT_MODEL : null,
      maxChanges: opts.maxChanges ?? 1,
      done: 0,
      running: true,
      idlePolls: 0,
      errors: 0,
      lease: opts.kind === "llm" ? 300 : 180,
    };
    await this.ctx.storage.put("state", st);
    await this.ctx.storage.setAlarm(Date.now() + (opts.stagger ?? 0));
    return { ok: true };
  }

  async stop() {
    const st = await this.ctx.storage.get<RunnerState>("state");
    if (st) {
      st.running = false;
      await this.ctx.storage.put("state", st);
    }
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async status() {
    return (await this.ctx.storage.get<RunnerState>("state")) ?? null;
  }

  async alarm() {
    const st = await this.ctx.storage.get<RunnerState>("state");
    if (!st || !st.running) return;
    let again = false;
    try {
      again = await this.step(st);
      st.errors = 0;
    } catch (e) {
      st.errors++;
      st.lastError = `${new Date().toISOString()} ${String((e as Error).message).slice(0, 300)}`;
      console.error(`agent ${st.agent} step failed`, e);
      again = st.errors < 8;
      if (!again) {
        st.running = false;
        await this.coord().agentStatus({ agent: st.agent, status: "failed", kind: st.kind, model: st.model ?? undefined });
      }
    }
    await this.ctx.storage.put("state", st);
    if (again && st.running) await this.ctx.storage.setAlarm(Date.now() + (st.errors ? 2000 * st.errors : 400) + Math.random() * 2000);
  }

  /** One iteration. Returns true when the loop should continue. */
  private async step(st: RunnerState): Promise<boolean> {
    const coord = this.coord();
    const claim = await coord.claim({ agent: st.agent, kind: st.kind, model: st.model ?? undefined, lease: st.lease });
    if (!claim.change) {
      st.idlePolls++;
      if (st.idlePolls >= 6) {
        st.running = false;
        await coord.agentStatus({ agent: st.agent, status: "done", kind: st.kind, model: st.model ?? undefined });
        return false;
      }
      await this.ctx.storage.setAlarm(Date.now() + 4000 + Math.random() * 4000);
      return false;
    }
    st.idlePolls = 0;
    const change = claim.change;
    try {
      const ws = await clone({ remote: claim.remote, token: claim.token, branch: BRANCH, depth: 1 });
      const edit = st.kind === "synthetic" ? await syntheticEdit(change, ws, st.agent) : await llmEdit(this.env, change, ws, st.agent, st.model ?? EDIT_MODEL);
      const files: Record<string, string> = {};
      for (const [p, c] of Object.entries(edit.files)) if (inScope(p, change.scope) && typeof c === "string") files[p] = c;
      if (!Object.keys(files).length) throw new Error("the edit produced no files inside the declared scope");
      const message = `${change.title}\n\n${edit.summary}\n\nChange-Id: ${change.id}\nAttempt: ${change.attempt}\nAgent: ${st.agent}\n`;
      const sha = await commitFiles(ws, files, message, { name: st.agent, email: `${st.agent}@agents.braid.dev` });
      await push(ws, { remote: claim.remote, token: claim.token, branch: BRANCH });
      await coord.submit({ changeId: change.id, agent: st.agent, head_sha: sha, summary: edit.summary, rationale: edit.rationale, model: st.model });
      st.done++;
    } catch (e) {
      const reason = `agent error: ${String((e as Error).message).slice(0, 240)}`;
      await coord.release({ changeId: change.id, agent: st.agent, reason });
      throw e;
    }
    if (st.done >= st.maxChanges) {
      st.running = false;
      await coord.agentStatus({ agent: st.agent, status: "done", kind: st.kind, model: st.model ?? undefined });
      return false;
    }
    return true;
  }
}

/** Deterministic edit for the sponsor-wall swarm: append one entry to sponsors.json. */
async function syntheticEdit(change: Change, ws: Workspace, agent: string): Promise<EditResult> {
  const path = change.scope[0] ?? "sponsors.json";
  const current = (await ws.fs.readText(`${ws.dir}/${path}`)) ?? '{"sponsors":[]}';
  let data: { sponsors: Array<Record<string, string>> };
  try {
    data = JSON.parse(current);
  } catch {
    data = { sponsors: [] };
  }
  if (!Array.isArray(data.sponsors)) data.sponsors = [];
  const name = change.title.replace(/^Add sponsor\s+/i, "").toUpperCase();
  const tier = /"tier":"(\w+)"/.exec(change.body)?.[1] ?? "community";
  data.sponsors.push({ name, tier, by: agent });
  return { files: { [path]: JSON.stringify(data, null, 2) + "\n" }, summary: `Add ${name} (${tier}) to the sponsor wall`, rationale: `Appended one entry to ${path}; nothing else touched.` };
}

/** Ask a Workers AI model for the edit, with one retry when it does not return usable JSON. */
async function llmEdit(env: Env, change: Change, ws: Workspace, agent: string, model: string): Promise<EditResult> {
  const files: Record<string, string | null> = {};
  for (const p of change.scope) if (!p.endsWith("/") && !p.endsWith("*")) files[p] = await ws.fs.readText(`${ws.dir}/${p}`);
  const context: Record<string, string | null> = {};
  for (const p of CONTEXT_FILES) if (!(p in files)) context[p] = await ws.fs.readText(`${ws.dir}/${p}`);
  const messages = editMessages(change, files, context, agent);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await chat(env, model, messages, { json: true, max_tokens: 4000, temperature: attempt === 0 ? 0.3 : 0.6 });
    const parsed = extractJson<EditResult>(last);
    if (parsed && parsed.files && typeof parsed.files === "object") {
      const out: Record<string, string> = {};
      for (const [p, c] of Object.entries(parsed.files)) if (typeof c === "string" && c.length > 0) out[p] = c.endsWith("\n") ? c : c + "\n";
      if (Object.keys(out).length) return { files: out, summary: String(parsed.summary ?? change.title).slice(0, 300), rationale: String(parsed.rationale ?? "").slice(0, 600) };
    }
  }
  throw new Error(`model returned no usable edit: ${last.slice(0, 120)}`);
}
