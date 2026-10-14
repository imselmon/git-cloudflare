/**
 * Integrator: the only writer to trunk. It drains the queue of submitted
 * attempts in batches ("weaves"): a clone-free Merkle diff of each strand,
 * deterministic scope enforcement, an optional model review against the
 * change's own intent, a three-way merge onto the current trunk, one commit
 * per change with provenance trailers and notes, and a single push per batch.
 * A real conflict is never written to trunk; the change is sent back for replay.
 */
import { DurableObject } from "cloudflare:workers";
import type { AgentKind, Change, LandingResult } from "./types";
import { BRANCH } from "./types";
import { clone, commitFiles, push, addNote, headSha, type Workspace } from "./git";
import { getRepo, treeDiff, blobText, inScope } from "./artifacts";
import { threeWay, simpleDiff } from "./merge";
import { chat, extractJson, reviewMessages, REVIEW_MODEL, type ReviewResult } from "./llm";

export interface QueueItem {
  attempt_id: string;
  change_id: string;
  n: number;
  agent_id: string;
  kind: AgentKind;
  model: string | null;
  strand: string;
  base_sha: string;
  head_sha: string;
  title: string;
  body: string;
  scope: string[];
  accept: string;
  summary: string;
  rationale: string;
  review: boolean;
  replay_of: string | null;
}

type Prepared =
  | { item: QueueItem; reject: string }
  | { item: QueueItem; files: Array<{ path: string; kind: "added" | "modified" | "deleted"; base: string | null; head: string | null }> };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, payload TEXT NOT NULL, enqueued_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;
const BATCH = 25;
const rid = (n = 8) => crypto.randomUUID().replace(/-/g, "").slice(0, n);

export class Integrator extends DurableObject<Env> {
  private sql: SqlStorage;
  private ws: Workspace | null = null;
  private token: { plaintext: string; exp: number } | null = null;
  private busy = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private get(k: string): string | null {
    const rows = this.sql.exec("SELECT v FROM settings WHERE k = ?", k).toArray();
    return rows.length ? String(rows[0].v) : null;
  }
  private set(k: string, v: string) {
    this.sql.exec("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  async reset(opts: { trunk_name: string; remote: string; sha: string }) {
    this.set("trunk_name", opts.trunk_name);
    this.set("remote", opts.remote);
    this.set("sha", opts.sha);
    this.sql.exec("DELETE FROM queue");
    this.ws = null;
    this.token = null;
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async enqueue(item: QueueItem) {
    this.sql.exec("INSERT OR REPLACE INTO queue (id, payload, enqueued_at, tries) VALUES (?, ?, ?, 0)", item.attempt_id, JSON.stringify(item), Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + 400);
    return { ok: true, depth: Number(this.sql.exec("SELECT COUNT(*) AS n FROM queue").toArray()[0].n) };
  }

  async status() {
    return { depth: Number(this.sql.exec("SELECT COUNT(*) AS n FROM queue").toArray()[0].n), trunk: this.get("trunk_name"), sha: this.get("sha"), busy: this.busy };
  }

  async alarm() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.weave();
    } catch (e) {
      console.error("weave failed", e);
      this.ws = null; // force a fresh clone next time
    } finally {
      this.busy = false;
    }
    const depth = Number(this.sql.exec("SELECT COUNT(*) AS n FROM queue").toArray()[0].n);
    if (depth > 0) await this.ctx.storage.setAlarm(Date.now() + 150);
  }

  private async trunkToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 120_000) return this.token.plaintext;
    using repo = await getRepo(this.env.ARTIFACTS, this.get("trunk_name")!);
    const tok = await repo.createToken("write", 3600);
    this.token = { plaintext: tok.plaintext, exp: Date.now() + 3600_000 };
    return tok.plaintext;
  }

  private async workspace(): Promise<Workspace> {
    if (this.ws) return this.ws;
    const token = await this.trunkToken();
    this.ws = await clone({ remote: this.get("remote")!, token, branch: BRANCH, depth: 1 });
    return this.ws;
  }

  private async prepare(item: QueueItem): Promise<Prepared> {
    try {
      using repo = await getRepo(this.env.ARTIFACTS, item.strand);
      const changes = await treeDiff(repo, item.base_sha, item.head_sha);
      if (changes.length === 0) return { item, reject: "the submitted commit changes nothing" };
      const outside = changes.filter((c) => !inScope(c.path, item.scope)).map((c) => c.path);
      if (outside.length) return { item, reject: `touched files outside the declared scope: ${outside.join(", ")}` };
      if (changes.length > 40) return { item, reject: `too many files changed (${changes.length})` };
      const files = await Promise.all(changes.map(async (c) => ({ path: c.path, kind: c.kind, base: await blobText(repo, c.baseHash), head: await blobText(repo, c.headHash) })));
      return { item, files };
    } catch (e) {
      return { item, reject: `could not read the strand: ${String((e as Error).message).slice(0, 200)}` };
    }
  }

  private async review(item: QueueItem, files: Array<{ path: string; base: string | null; head: string | null }>): Promise<ReviewResult | null> {
    const diff = files.map((f) => simpleDiff(f.path, f.base, f.head, 2500)).join("\n\n");
    const change: Change = { id: item.change_id, title: item.title, body: item.body, scope: item.scope, accept: item.accept, status: "queued", attempt: item.n, hint: null, created_by: "", created_at: 0, updated_at: 0, landed_sha: null, priority: 0 };
    try {
      const text = await chat(this.env, REVIEW_MODEL, reviewMessages(change, diff), { json: true, max_tokens: 600, temperature: 0.1 });
      const r = extractJson<ReviewResult>(text);
      if (!r || typeof r.conforms !== "boolean") return null;
      return { conforms: r.conforms, risk: (["low", "medium", "high"] as const).includes(r.risk) ? r.risk : "medium", notes: String(r.notes ?? "").slice(0, 400) };
    } catch (e) {
      console.error("review failed", e);
      return null;
    }
  }

  private message(item: QueueItem, mergeKind: string, review: ReviewResult | null, weave: string): string {
    const lines = [item.title, "", item.summary || "(no summary)", ""];
    lines.push(`Change-Id: ${item.change_id}`);
    lines.push(`Attempt: ${item.n}`);
    lines.push(`Agent: ${item.agent_id} (${item.kind}${item.model ? ":" + item.model : ""})`);
    lines.push(`Scope: ${item.scope.join(", ")}`);
    lines.push(`Merge: ${mergeKind}`);
    if (review) lines.push(`Reviewed-By: braid-reviewer (${REVIEW_MODEL}) conforms=${review.conforms} risk=${review.risk}`);
    if (item.replay_of) lines.push(`Replay-Of: ${item.replay_of}`);
    lines.push(`Weave: ${weave}`);
    return lines.join("\n") + "\n";
  }

  private async weave() {
    const rows = this.sql.exec("SELECT * FROM queue ORDER BY enqueued_at LIMIT ?", BATCH).toArray();
    if (!rows.length) return;
    const items = rows.map((r) => JSON.parse(String(r.payload)) as QueueItem);
    const weave = `wv_${rid(6)}`;
    const results: LandingResult[] = [];
    const ws = await this.workspace();

    const prepared = await Promise.all(items.map((it) => this.prepare(it)));
    let committed = 0;
    for (const p of prepared) {
      const item = p.item;
      if ("reject" in p) {
        results.push({ attempt_id: item.attempt_id, change_id: item.change_id, outcome: "rejected", reason: p.reject });
        continue;
      }
      let review: ReviewResult | null = null;
      if (item.review) {
        review = await this.review(item, p.files);
        if (review && !review.conforms) {
          results.push({ attempt_id: item.attempt_id, change_id: item.change_id, outcome: "rejected", reason: `reviewer: ${review.notes}`, review, files: p.files.map((f) => f.path) });
          continue;
        }
      }
      const merged: Record<string, string | null> = {};
      let mergeKind: "clean" | "merged" | "union" = "clean";
      let conflict: string | null = null;
      for (const f of p.files) {
        const trunkText = await ws.fs.readText(`${ws.dir}/${f.path}`);
        const r = threeWay(f.path, f.base, trunkText, f.head);
        if (!r.ok) {
          conflict = r.reason;
          break;
        }
        if (r.kind === "same") continue;
        if (r.kind === "union") mergeKind = "union";
        else if (r.kind === "merged" && mergeKind === "clean") mergeKind = "merged";
        merged[f.path] = f.head === null ? null : r.text;
      }
      if (conflict) {
        results.push({ attempt_id: item.attempt_id, change_id: item.change_id, outcome: "replay", reason: conflict, review: review ?? undefined, files: p.files.map((f) => f.path) });
        continue;
      }
      const paths = Object.keys(merged);
      if (!paths.length) {
        results.push({ attempt_id: item.attempt_id, change_id: item.change_id, outcome: "landed", reason: "trunk already contained this change", files: [], trunk_sha: await headSha(ws), review: review ?? undefined, kind: "clean" });
        continue;
      }
      const author = { name: item.agent_id, email: `${item.agent_id}@agents.braid.dev` };
      const sha = await commitFiles(ws, merged, this.message(item, mergeKind, review, weave), author);
      try {
        await addNote(ws, sha, JSON.stringify({ change: { id: item.change_id, title: item.title, body: item.body, scope: item.scope, accept: item.accept }, attempt: { id: item.attempt_id, n: item.n, agent: item.agent_id, kind: item.kind, model: item.model, strand: item.strand, base: item.base_sha, head: item.head_sha }, rationale: item.rationale, review, merge: mergeKind, weave }, null, 2), author, "braid");
      } catch (e) {
        console.error("note failed", e);
      }
      committed++;
      results.push({ attempt_id: item.attempt_id, change_id: item.change_id, outcome: mergeKind === "clean" ? "landed" : "auto-merged", files: paths, trunk_sha: sha, review: review ?? undefined, kind: mergeKind });
    }

    let trunkSha: string | null = this.get("sha");
    if (committed > 0) {
      const token = await this.trunkToken();
      const remote = this.get("remote")!;
      try {
        await push(ws, { remote, token, branch: BRANCH });
        try {
          await push(ws, { remote, token, ref: "refs/notes/braid", remoteRef: "refs/notes/braid" });
        } catch (e) {
          console.error("notes push failed", e);
        }
      } catch (e) {
        // Trunk moved under us (should not happen: we are the only writer). Drop the workspace and retry the batch.
        this.ws = null;
        this.sql.exec(`UPDATE queue SET tries = tries + 1 WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => String(r.id)));
        const dead = this.sql.exec("SELECT id FROM queue WHERE tries >= 3").toArray();
        if (dead.length) {
          const failed: LandingResult[] = dead.map((d) => ({ attempt_id: String(d.id), change_id: (JSON.parse(String(rows.find((r) => r.id === d.id)?.payload ?? "{}")) as QueueItem).change_id ?? "", outcome: "failed", reason: `weave push failed repeatedly: ${String((e as Error).message).slice(0, 160)}` }));
          this.sql.exec(`DELETE FROM queue WHERE id IN (${dead.map(() => "?").join(",")})`, ...dead.map((d) => String(d.id)));
          await this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("main")).landed({ results: failed.filter((f) => f.change_id), trunk_sha: null, weave });
        }
        throw e;
      }
      trunkSha = await headSha(ws);
      this.set("sha", trunkSha);
    }
    this.sql.exec(`DELETE FROM queue WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => String(r.id)));
    await this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("main")).landed({ results, trunk_sha: trunkSha, weave });
  }
}
