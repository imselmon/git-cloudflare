/**
 * Coordinator: one Durable Object per project. It owns the backlog of changes,
 * hands out claims (a forked strand plus a write token whose TTL is the lease),
 * queues submitted attempts for the Integrator, records outcomes and streams
 * events to dashboards over WebSockets. Single-threaded, so claims are
 * linearizable: a change is reserved synchronously before any network call.
 */
import { DurableObject } from "cloudflare:workers";
import type { AgentKind, AttemptOutcome, Change, ChangeStatus, ClaimResponse, LandingResult, Mode, Stats } from "./types";
import { BRANCH } from "./types";
import { SEED_FILES } from "./seed-files";
import { SEED_CHANGES, sponsorChange, type SeedChange } from "./backlog";
import { initAndPush } from "./git";
import { getRepo } from "./artifacts";
import type { QueueItem } from "./integrator";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, scope TEXT NOT NULL, accept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'any', status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, hint TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, landed_sha TEXT,
  priority INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS changes_status ON changes(status, priority DESC, created_at);
CREATE TABLE IF NOT EXISTS claims (
  change_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, strand TEXT NOT NULL, remote TEXT NOT NULL,
  base_sha TEXT NOT NULL, token_id TEXT NOT NULL, lease_expires INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
  attempt_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, change_id TEXT NOT NULL, n INTEGER NOT NULL, agent_id TEXT NOT NULL, strand TEXT NOT NULL,
  base_sha TEXT NOT NULL, head_sha TEXT, model TEXT, summary TEXT, rationale TEXT, review TEXT, outcome TEXT,
  reason TEXT, files TEXT, trunk_sha TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS attempts_change ON attempts(change_id, n);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT, status TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;
const rid = (n = 8) => crypto.randomUUID().replace(/-/g, "").slice(0, n);
const AUTHOR = { name: "braid", email: "braid@braid.dev" };
const MAX_ATTEMPTS = 4;

function rowToChange(r: Row): Change {
  return {
    id: String(r.id),
    title: String(r.title),
    body: String(r.body),
    scope: JSON.parse(String(r.scope)) as string[],
    accept: String(r.accept),
    status: String(r.status) as ChangeStatus,
    attempt: Number(r.attempt),
    hint: r.hint == null ? null : String(r.hint),
    created_by: String(r.created_by),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    landed_sha: r.landed_sha == null ? null : String(r.landed_sha),
    priority: Number(r.priority),
  };
}

function overlaps(a: string[], b: string[]): boolean {
  const hit = (x: string, y: string) => x === y || (x.endsWith("/") && y.startsWith(x)) || (y.endsWith("/") && x.startsWith(y)) || (x.endsWith("*") && y.startsWith(x.slice(0, -1))) || (y.endsWith("*") && x.startsWith(y.slice(0, -1)));
  for (const x of a) for (const y of b) if (hit(x, y)) return true;
  return false;
}

export class Coordinator extends DurableObject<Env> {
  private sql: SqlStorage;
  private preventedOnce = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // ---- settings and counters -------------------------------------------

  private get(k: string): string | null {
    const rows = this.sql.exec("SELECT v FROM settings WHERE k = ?", k).toArray();
    return rows.length ? String(rows[0].v) : null;
  }
  private set(k: string, v: string) {
    this.sql.exec("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  private bump(k: string, by = 1) {
    this.sql.exec("INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n", k, by);
  }
  private counter(k: string): number {
    const rows = this.sql.exec("SELECT n FROM counters WHERE k = ?", k).toArray();
    return rows.length ? Number(rows[0].n) : 0;
  }
  private mode(): Mode {
    return (this.get("mode") as Mode) ?? "claims";
  }

  private event(kind: string, data: Record<string, unknown>) {
    const ts = Date.now();
    this.sql.exec("INSERT INTO events (ts, kind, data) VALUES (?, ?, ?)", ts, kind, JSON.stringify(data));
    this.sql.exec("DELETE FROM events WHERE seq < (SELECT MAX(seq) FROM events) - 600");
    const msg = JSON.stringify({ type: "event", ts, kind, data });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* closed */
      }
    }
  }

  private change(id: string): Change | null {
    const rows = this.sql.exec("SELECT * FROM changes WHERE id = ?", id).toArray();
    return rows.length ? rowToChange(rows[0]) : null;
  }

  private touchAgent(id: string, kind: AgentKind, model: string | null, status: string) {
    this.sql.exec(
      "INSERT INTO agents (id, kind, model, status, done, last_seen) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_seen = excluded.last_seen, model = COALESCE(excluded.model, agents.model)",
      id, kind, model, status, Date.now(),
    );
  }

  private insertChange(c: SeedChange, by: string): string {
    const id = `ch_${rid()}`;
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO changes (id, title, body, scope, accept, kind, status, attempt, hint, created_by, created_at, updated_at, landed_sha, priority) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, NULL, ?, ?, ?, NULL, ?)",
      id, c.title, c.body, JSON.stringify(c.scope), c.accept, c.kind, by, now, now, c.priority ?? 0,
    );
    return id;
  }

  // ---- project lifecycle -------------------------------------------------

  async init(opts: { force?: boolean } = {}) {
    const existing = this.get("trunk_name");
    if (existing && !opts.force) {
      return { trunk: existing, remote: this.get("trunk_remote"), sha: this.get("trunk_sha"), seeded: false };
    }
    const trunkName = `trunk-${rid(6)}`;
    const created = await this.env.ARTIFACTS.create(trunkName, { setDefaultBranch: BRANCH, description: "Braid trunk: Loom Conf demo site" });
    const { sha } = await initAndPush({
      remote: created.remote,
      token: created.token,
      files: SEED_FILES,
      message: "Seed the Loom Conf site\n\nChange-Id: seed\nAgent: braid (system)\n",
      author: AUTHOR,
    });
    {
      using trunk = await getRepo(this.env.ARTIFACTS, trunkName);
      await trunk.revokeToken(created.token); // only the Integrator writes trunk, with its own short-lived tokens
    }
    for (const t of ["changes", "claims", "attempts", "agents", "events", "counters"]) this.sql.exec(`DELETE FROM ${t}`);
    this.preventedOnce.clear();
    for (const c of SEED_CHANGES) this.insertChange(c, "maintainer");
    this.set("trunk_name", trunkName);
    this.set("trunk_remote", created.remote);
    this.set("trunk_sha", sha);
    this.set("seeded_at", String(Date.now()));
    if (!this.get("mode")) this.set("mode", "claims");
    if (!this.get("review")) this.set("review", "on");
    await this.env.INTEGRATOR.get(this.env.INTEGRATOR.idFromName("main")).reset({ trunk_name: trunkName, remote: created.remote, sha });
    this.event("init", { trunk: trunkName, sha, changes: SEED_CHANGES.length });
    return { trunk: trunkName, remote: created.remote, sha, seeded: true };
  }

  async setMode(opts: { mode: Mode }) {
    this.set("mode", opts.mode);
    this.event("mode", { mode: opts.mode });
    return { mode: opts.mode };
  }

  async setReview(opts: { enabled: boolean }) {
    this.set("review", opts.enabled ? "on" : "off");
    this.event("review", { enabled: opts.enabled });
    return { review: opts.enabled };
  }

  // ---- reads ----------------------------------------------------------------

  stats(): Stats {
    const one = (q: string) => Number(this.sql.exec(q).toArray()[0]?.n ?? 0);
    return {
      agents: one("SELECT COUNT(*) AS n FROM agents WHERE status IN ('working','claiming','starting')"),
      strands: one("SELECT COUNT(*) AS n FROM attempts"),
      landed: this.counter("landed"),
      automerged: this.counter("automerged"),
      replayed: this.counter("replayed"),
      prevented: this.counter("prevented"),
      rejected: this.counter("rejected"),
      expired: this.counter("expired"),
      weaves: this.counter("weaves"),
      trunk_sha: this.get("trunk_sha"),
    };
  }

  async state() {
    const changes = this.sql.exec("SELECT * FROM changes ORDER BY updated_at DESC LIMIT 400").toArray().map(rowToChange);
    const byStatus: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT status, COUNT(*) AS n FROM changes GROUP BY status").toArray()) byStatus[String(r.status)] = Number(r.n);
    const agents = this.sql.exec("SELECT * FROM agents ORDER BY last_seen DESC LIMIT 300").toArray();
    const agentCounts: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT status, COUNT(*) AS n FROM agents GROUP BY status").toArray()) agentCounts[String(r.status)] = Number(r.n);
    const claims = this.sql.exec("SELECT c.*, ch.title, ch.scope FROM claims c JOIN changes ch ON ch.id = c.change_id ORDER BY claimed_at DESC LIMIT 300").toArray();
    const events = this.sql.exec("SELECT * FROM events ORDER BY seq DESC LIMIT 80").toArray().map((e) => ({ seq: Number(e.seq), ts: Number(e.ts), kind: String(e.kind), data: JSON.parse(String(e.data)) }));
    return {
      settings: {
        mode: this.mode(),
        review: this.get("review") !== "off",
        trunk_name: this.get("trunk_name"),
        trunk_sha: this.get("trunk_sha"),
        trunk_remote: this.get("trunk_remote"),
        seeded_at: Number(this.get("seeded_at") ?? 0),
      },
      stats: this.stats(),
      changes,
      change_counts: byStatus,
      agents,
      agent_counts: agentCounts,
      claims,
      events,
    };
  }

  async changeDetail(opts: { id: string }) {
    const change = this.change(opts.id);
    if (!change) return null;
    const attempts = this.sql.exec("SELECT * FROM attempts WHERE change_id = ? ORDER BY n", opts.id).toArray();
    const claim = this.sql.exec("SELECT * FROM claims WHERE change_id = ?", opts.id).toArray()[0] ?? null;
    return { change, attempts, claim };
  }

  async listChanges(opts: { status?: string; limit?: number } = {}) {
    const limit = Math.min(500, opts.limit ?? 100);
    const rows = opts.status
      ? this.sql.exec("SELECT * FROM changes WHERE status = ? ORDER BY priority DESC, created_at LIMIT ?", opts.status, limit).toArray()
      : this.sql.exec("SELECT * FROM changes ORDER BY updated_at DESC LIMIT ?", limit).toArray();
    return rows.map(rowToChange);
  }

  async listAttempts(opts: { outcome?: string; agent?: string; limit?: number } = {}) {
    const limit = Math.min(500, opts.limit ?? 100);
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (opts.outcome) { where.push("a.outcome = ?"); args.push(opts.outcome); }
    if (opts.agent) { where.push("a.agent_id = ?"); args.push(opts.agent); }
    const rows = this.sql.exec(`SELECT a.*, c.title FROM attempts a JOIN changes c ON c.id = a.change_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.created_at DESC LIMIT ?`, ...args, limit).toArray();
    const counts: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT COALESCE(outcome, 'pending') AS o, COUNT(*) AS n FROM attempts GROUP BY o").toArray()) counts[String(r.o)] = Number(r.n);
    return { counts, attempts: rows };
  }

  async listEvents(opts: { kind?: string; limit?: number } = {}) {
    const limit = Math.min(600, opts.limit ?? 200);
    const rows = opts.kind
      ? this.sql.exec("SELECT * FROM events WHERE kind = ? ORDER BY seq DESC LIMIT ?", opts.kind, limit).toArray()
      : this.sql.exec("SELECT * FROM events ORDER BY seq DESC LIMIT ?", limit).toArray();
    return rows.map((e) => ({ seq: Number(e.seq), ts: Number(e.ts), kind: String(e.kind), data: JSON.parse(String(e.data)) }));
  }

  async why(opts: { path: string }) {
    const needle = `%${JSON.stringify(opts.path)}%`;
    const rows = this.sql
      .exec(
        "SELECT a.*, c.title, c.body, c.scope, c.accept FROM attempts a JOIN changes c ON c.id = a.change_id WHERE a.files LIKE ? AND a.outcome IN ('landed','auto-merged') ORDER BY a.finished_at DESC LIMIT 50",
        needle,
      )
      .toArray();
    return rows.map((r) => ({ ...r, scope: JSON.parse(String(r.scope)), review: r.review ? JSON.parse(String(r.review)) : null, files: r.files ? JSON.parse(String(r.files)) : [] }));
  }

  // ---- changes ----------------------------------------------------------------

  async createChange(input: { title: string; body: string; scope: string[]; accept?: string; kind?: AgentKind | "any"; priority?: number; by?: string }) {
    if (!input.title || !Array.isArray(input.scope) || input.scope.length === 0) throw new Error("title and a non-empty scope are required");
    const id = this.insertChange(
      { title: input.title, body: input.body ?? "", scope: input.scope, accept: input.accept ?? "", kind: input.kind ?? "any", priority: input.priority ?? 3 },
      input.by ?? "api",
    );
    this.event("proposed", { change_id: id, title: input.title, by: input.by ?? "api", scope: input.scope });
    return { id, change: this.change(id) };
  }

  // ---- claims -------------------------------------------------------------------

  async claim(input: { agent: string; kind?: AgentKind; model?: string; changeId?: string; lease?: number }): Promise<ClaimResponse | { change: null; reason: string }> {
    const kind: AgentKind = input.kind ?? "external";
    const lease = Math.max(60, Math.min(3600, Math.floor(input.lease ?? (kind === "llm" ? 300 : kind === "external" ? 900 : 180))));
    this.touchAgent(input.agent, kind, input.model ?? null, "claiming");
    const trunkName = this.get("trunk_name");
    if (!trunkName) return { change: null, reason: "project not initialised" };
    const existing = this.sql.exec("SELECT change_id FROM claims WHERE agent_id = ?", input.agent).toArray();
    if (existing.length) return { change: null, reason: `agent already holds ${String(existing[0].change_id)}; submit or release it first` };

    let pick: Change | null = null;
    if (input.changeId) {
      const c = this.change(input.changeId);
      if (!c) return { change: null, reason: "no such change" };
      if (c.status !== "open") return { change: null, reason: `change is ${c.status}` };
      pick = c;
    } else {
      const kinds = kind === "synthetic" ? ["synthetic"] : kind === "llm" ? ["llm", "any"] : ["llm", "any", "external"];
      const marks = kinds.map(() => "?").join(",");
      const open = this.sql.exec(`SELECT * FROM changes WHERE status = 'open' AND kind IN (${marks}) ORDER BY priority DESC, attempt DESC, created_at ASC LIMIT 300`, ...kinds).toArray().map(rowToChange);
      // Status is set synchronously at reservation time, so in-flight claims count too (the claims row lands only after the fork).
      const activeScopes = this.mode() === "claims" ? this.sql.exec("SELECT scope FROM changes WHERE status IN ('claimed', 'queued')").toArray().map((r) => JSON.parse(String(r.scope)) as string[]) : [];
      for (const c of open) {
        if (activeScopes.some((s) => overlaps(c.scope, s))) {
          if (!this.preventedOnce.has(c.id)) {
            this.preventedOnce.add(c.id);
            this.bump("prevented");
            this.event("prevented", { change_id: c.id, title: c.title, agent: input.agent });
          }
          continue;
        }
        pick = c;
        break;
      }
    }
    if (!pick) {
      this.touchAgent(input.agent, kind, input.model ?? null, "idle");
      return { change: null, reason: "nothing claimable right now" };
    }

    // Reserve synchronously, then do the slow network work.
    const now = Date.now();
    const n = pick.attempt + 1;
    this.sql.exec("UPDATE changes SET status = 'claimed', attempt = ?, updated_at = ? WHERE id = ? AND status = 'open'", n, now, pick.id);
    const attemptId = `at_${rid()}`;
    const strand = `strand-${pick.id.slice(3)}-${n}`;
    let stage = "get-trunk";
    try {
      const ns = this.env.ARTIFACTS;
      using trunk = await getRepo(ns, trunkName);
      stage = "fork";
      let forked: { name: string; remote: string; token: string | null } | null = null;
      for (let i = 0; !forked; i++) {
        try {
          forked = await trunk.fork(strand, { defaultBranchOnly: true, description: `${pick.title} · attempt ${n} · ${input.agent}` });
        } catch (e) {
          const code = (e as { code?: string }).code ?? "";
          if (code === "ALREADY_EXISTS" || /ALREADY_EXISTS/.test(String((e as Error).message))) {
            using s = await getRepo(ns, strand);
            forked = { name: strand, remote: (await s.info()).remote, token: null };
          } else if (i >= 4) throw e;
          else await new Promise((r) => setTimeout(r, 500 * (i + 1) + Math.random() * 500));
        }
      }
      stage = "get-strand";
      using srepo = await getRepo(ns, forked.name);
      stage = "token";
      const [tok, head] = await Promise.all([srepo.createToken("write", lease), srepo.log({ ref: BRANCH, limit: 1 })]);
      stage = "revoke-initial";
      if (forked.token) {
        try {
          await srepo.revokeToken(forked.token); // the fork's day-long token must not outlive the lease
        } catch {
          /* best effort */
        }
      }
      const baseSha = head[0]?.hash ?? this.get("trunk_sha") ?? "";
      const leaseExpires = now + lease * 1000;
      this.sql.exec(
        "INSERT INTO claims (change_id, agent_id, strand, remote, base_sha, token_id, lease_expires, claimed_at, attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        pick.id, input.agent, forked.name, forked.remote, baseSha, tok.id, leaseExpires, now, attemptId,
      );
      this.sql.exec(
        "INSERT INTO attempts (id, change_id, n, agent_id, strand, base_sha, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        attemptId, pick.id, n, input.agent, forked.name, baseSha, input.model ?? null, now,
      );
      this.touchAgent(input.agent, kind, input.model ?? null, "working");
      this.event("claimed", { change_id: pick.id, title: pick.title, agent: input.agent, strand: forked.name, attempt: n, lease, replay: n > 1 });
      await this.ctx.storage.setAlarm(Math.min(leaseExpires, now + 10_000));
      const change = { ...pick, status: "claimed" as ChangeStatus, attempt: n };
      return { change, strand: forked.name, remote: forked.remote, token: tok.plaintext, base_sha: baseSha, lease_expires: leaseExpires, attempt_id: attemptId, mode: this.mode() };
    } catch (e) {
      this.sql.exec("UPDATE changes SET status = 'open', attempt = ?, updated_at = ? WHERE id = ?", pick.attempt, Date.now(), pick.id);
      this.sql.exec("DELETE FROM attempts WHERE id = ?", attemptId);
      this.event("error", { where: `claim:${stage}`, agent: input.agent, message: String((e as Error).message) });
      throw new Error(`claim failed at ${stage}: ${String((e as Error).message)}`);
    }
  }

  async renew(input: { changeId: string; agent: string; lease?: number }) {
    const claim = this.sql.exec("SELECT * FROM claims WHERE change_id = ?", input.changeId).toArray()[0];
    if (!claim || String(claim.agent_id) !== input.agent) throw new Error("no such claim for this agent");
    const lease = Math.max(60, Math.min(3600, Math.floor(input.lease ?? 300)));
    using repo = await getRepo(this.env.ARTIFACTS, String(claim.strand));
    const tok = await repo.createToken("write", lease);
    try {
      await repo.revokeToken(String(claim.token_id));
    } catch {
      /* already expired */
    }
    const leaseExpires = Date.now() + lease * 1000;
    this.sql.exec("UPDATE claims SET token_id = ?, lease_expires = ? WHERE change_id = ?", tok.id, leaseExpires, input.changeId);
    this.event("renewed", { change_id: input.changeId, agent: input.agent, lease });
    return { token: tok.plaintext, lease_expires: leaseExpires };
  }

  async submit(input: { changeId: string; agent: string; head_sha: string; summary?: string; rationale?: string; model?: string | null }) {
    const claim = this.sql.exec("SELECT * FROM claims WHERE change_id = ?", input.changeId).toArray()[0];
    if (!claim || String(claim.agent_id) !== input.agent) throw new Error("no active claim for this agent on that change");
    const change = this.change(input.changeId)!;
    if (!/^[0-9a-f]{40}$/.test(input.head_sha)) throw new Error("head_sha must be a 40-hex commit id");
    const now = Date.now();
    this.sql.exec("UPDATE attempts SET head_sha = ?, summary = ?, rationale = ?, model = COALESCE(?, model) WHERE id = ?", input.head_sha, input.summary ?? null, input.rationale ?? null, input.model ?? null, String(claim.attempt_id));
    this.sql.exec("UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ?", now, change.id);
    const agent = this.sql.exec("SELECT * FROM agents WHERE id = ?", input.agent).toArray()[0];
    const kind = (agent ? String(agent.kind) : "external") as AgentKind;
    const prev = this.sql.exec("SELECT id FROM attempts WHERE change_id = ? AND n = ?", change.id, change.attempt - 1).toArray()[0];
    const item: QueueItem = {
      attempt_id: String(claim.attempt_id),
      change_id: change.id,
      n: change.attempt,
      agent_id: input.agent,
      kind,
      model: input.model ?? (agent?.model ? String(agent.model) : null),
      strand: String(claim.strand),
      base_sha: String(claim.base_sha),
      head_sha: input.head_sha,
      title: change.title,
      body: change.body,
      scope: change.scope,
      accept: change.accept,
      summary: input.summary ?? "",
      rationale: input.rationale ?? "",
      review: this.get("review") !== "off" && kind !== "synthetic",
      replay_of: prev ? String(prev.id) : null,
    };
    this.event("submitted", { change_id: change.id, title: change.title, agent: input.agent, head_sha: input.head_sha, summary: input.summary ?? "" });
    await this.env.INTEGRATOR.get(this.env.INTEGRATOR.idFromName("main")).enqueue(item);
    return { ok: true, queued: true, attempt_id: item.attempt_id };
  }

  private async endClaim(changeId: string, outcome: AttemptOutcome, reason: string, nextStatus: ChangeStatus, revoke: boolean) {
    const claim = this.sql.exec("SELECT * FROM claims WHERE change_id = ?", changeId).toArray()[0];
    if (!claim) return false;
    this.sql.exec("DELETE FROM claims WHERE change_id = ?", changeId);
    this.sql.exec("UPDATE attempts SET outcome = ?, reason = ?, finished_at = ? WHERE id = ?", outcome, reason, Date.now(), String(claim.attempt_id));
    this.sql.exec("UPDATE changes SET status = ?, hint = ?, updated_at = ? WHERE id = ?", nextStatus, reason, Date.now(), changeId);
    this.preventedOnce.delete(changeId);
    if (revoke) {
      try {
        using repo = await getRepo(this.env.ARTIFACTS, String(claim.strand));
        await repo.revokeToken(String(claim.token_id));
      } catch {
        /* strand gone or token expired */
      }
    }
    return true;
  }

  async release(input: { changeId: string; agent: string; reason?: string }) {
    const change = this.change(input.changeId);
    if (!change) throw new Error("no such change");
    const next: ChangeStatus = change.attempt >= MAX_ATTEMPTS ? "failed" : "open";
    const ok = await this.endClaim(input.changeId, "released", input.reason ?? "released by agent", next, true);
    this.touchAgent(input.agent, "external", null, "idle");
    this.event("released", { change_id: input.changeId, title: change.title, agent: input.agent, reason: input.reason ?? "" });
    return { ok };
  }

  async revoke(input: { agent: string }) {
    const claims = this.sql.exec("SELECT change_id FROM claims WHERE agent_id = ?", input.agent).toArray();
    for (const c of claims) await this.endClaim(String(c.change_id), "expired", `lease revoked for ${input.agent}`, "open", true);
    this.sql.exec("UPDATE agents SET status = 'revoked', last_seen = ? WHERE id = ?", Date.now(), input.agent);
    try {
      await this.env.AGENT.get(this.env.AGENT.idFromName(input.agent)).stop();
    } catch {
      /* external agent */
    }
    this.bump("expired", claims.length);
    this.event("revoked", { agent: input.agent, changes: claims.map((c) => String(c.change_id)) });
    return { ok: true, released: claims.length };
  }

  async agentStatus(input: { agent: string; status: string; kind?: AgentKind; model?: string }) {
    this.touchAgent(input.agent, input.kind ?? "external", input.model ?? null, input.status);
    return { ok: true };
  }

  // ---- results from the Integrator ------------------------------------------

  async landed(input: { results: LandingResult[]; trunk_sha: string | null; weave: string }) {
    for (const r of input.results) {
      const change = this.change(r.change_id);
      if (!change) continue;
      this.sql.exec(
        "UPDATE attempts SET outcome = ?, reason = ?, files = ?, trunk_sha = ?, review = ?, finished_at = ? WHERE id = ?",
        r.outcome, r.reason ?? null, JSON.stringify(r.files ?? []), r.trunk_sha ?? null, r.review ? JSON.stringify(r.review) : null, Date.now(), r.attempt_id,
      );
      this.sql.exec("DELETE FROM claims WHERE change_id = ?", r.change_id);
      this.preventedOnce.delete(r.change_id);
      const attempt = this.sql.exec("SELECT agent_id FROM attempts WHERE id = ?", r.attempt_id).toArray()[0];
      const agent = attempt ? String(attempt.agent_id) : "";
      if (r.outcome === "landed" || r.outcome === "auto-merged") {
        this.sql.exec("UPDATE changes SET status = 'landed', landed_sha = ?, hint = NULL, updated_at = ? WHERE id = ?", r.trunk_sha ?? null, Date.now(), r.change_id);
        this.sql.exec("UPDATE agents SET done = done + 1 WHERE id = ?", agent);
        this.bump("landed");
        if (r.outcome === "auto-merged") this.bump("automerged");
        this.event(r.outcome, { change_id: r.change_id, title: change.title, agent, files: r.files ?? [], trunk_sha: r.trunk_sha, kind: r.kind, review: r.review ?? null });
      } else if (r.outcome === "replay") {
        const next: ChangeStatus = change.attempt >= MAX_ATTEMPTS ? "failed" : "open";
        const hint = `Attempt ${change.attempt} conflicted with work that landed on trunk meanwhile (${r.reason}). Re-apply the change on the current files.`;
        this.sql.exec("UPDATE changes SET status = ?, hint = ?, priority = priority + 1, updated_at = ? WHERE id = ?", next, hint, Date.now(), r.change_id);
        this.bump("replayed");
        this.event("replay", { change_id: r.change_id, title: change.title, agent, reason: r.reason, attempt: change.attempt, next });
      } else {
        const next: ChangeStatus = change.attempt >= MAX_ATTEMPTS - 1 ? "failed" : "open";
        const hint = `Attempt ${change.attempt} was rejected: ${r.reason}`;
        this.sql.exec("UPDATE changes SET status = ?, hint = ?, updated_at = ? WHERE id = ?", next, hint, Date.now(), r.change_id);
        this.bump("rejected");
        this.event("rejected", { change_id: r.change_id, title: change.title, agent, reason: r.reason, attempt: change.attempt, next, review: r.review ?? null });
      }
    }
    if (input.trunk_sha) this.set("trunk_sha", input.trunk_sha);
    this.bump("weaves");
    this.event("weave", { weave: input.weave, count: input.results.length, trunk_sha: input.trunk_sha, landed: input.results.filter((r) => r.outcome === "landed" || r.outcome === "auto-merged").length });
    return { ok: true };
  }

  // ---- swarm -----------------------------------------------------------------

  async swarm(input: { n: number; kind: AgentKind; model?: string; maxChanges?: number }) {
    const n = Math.max(1, Math.min(2000, Math.floor(input.n)));
    const seed = rid(4);
    if (input.kind === "synthetic") {
      for (let i = 1; i <= n; i++) this.insertChange(sponsorChange(i, seed), "swarm");
    }
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) ids.push(`${input.kind === "llm" ? "agent" : "bot"}-${seed}-${i}`);
    for (const id of ids) this.touchAgent(id, input.kind, input.model ?? null, "starting");
    this.event("swarm", { n, kind: input.kind, model: input.model ?? null });
    const spread = Math.min(90_000, n * 80);
    for (let i = 0; i < ids.length; i += 50) {
      await Promise.all(
        ids.slice(i, i + 50).map((id, j) =>
          this.env.AGENT.get(this.env.AGENT.idFromName(id)).start({
            agent: id,
            kind: input.kind,
            model: input.model ?? null,
            maxChanges: input.maxChanges ?? (input.kind === "synthetic" ? 1 : 3),
            stagger: Math.floor(((i + j) / n) * spread),
          }),
        ),
      );
    }
    return { started: ids.length, agents: ids.slice(0, 20) };
  }

  /** Stage a guaranteed conflict: two changes that rewrite the same headline, in optimistic mode, with two agents. */
  async demoConflict() {
    this.set("mode", "optimistic");
    this.event("mode", { mode: "optimistic", why: "conflict demo" });
    const seed = rid(3);
    const a = this.insertChange({ title: `Rename the hero headline to “Loom Conf Lisbon”`, body: "In sections/hero.html change the <h1> text to exactly: Loom Conf Lisbon: agents that build, together. Keep every other line exactly as it is.", scope: ["sections/hero.html"], accept: "The h1 reads 'Loom Conf Lisbon: agents that build, together.'", kind: "llm", priority: 9 }, "demo");
    const b = this.insertChange({ title: `Shorten the hero headline`, body: "In sections/hero.html change the <h1> text to exactly: Agents that build. Keep every other line exactly as it is.", scope: ["sections/hero.html"], accept: "The h1 reads 'Agents that build.'", kind: "llm", priority: 9 }, "demo");
    const ids = [`agent-${seed}-a`, `agent-${seed}-b`];
    for (const id of ids) this.touchAgent(id, "llm", null, "starting");
    await Promise.all([
      this.env.AGENT.get(this.env.AGENT.idFromName(ids[0])).start({ agent: ids[0], kind: "llm", maxChanges: 1, stagger: 0 }),
      this.env.AGENT.get(this.env.AGENT.idFromName(ids[1])).start({ agent: ids[1], kind: "llm", maxChanges: 1, stagger: 50 }),
    ]);
    this.event("swarm", { n: 2, kind: "llm", model: null, demo: "conflict" });
    return { changes: [a, b], agents: ids };
  }

  async stopAll() {
    const rows = this.sql.exec("SELECT id FROM agents WHERE status IN ('working','claiming','starting','idle')").toArray();
    for (let i = 0; i < rows.length; i += 50) {
      await Promise.all(rows.slice(i, i + 50).map((r) => this.env.AGENT.get(this.env.AGENT.idFromName(String(r.id))).stop().catch(() => undefined)));
    }
    this.sql.exec("UPDATE agents SET status = 'stopped' WHERE status IN ('working','claiming','starting','idle')");
    this.event("stopped", { agents: rows.length });
    return { stopped: rows.length };
  }

  // ---- leases ------------------------------------------------------------------

  async alarm() {
    const now = Date.now();
    const expired = this.sql.exec("SELECT c.change_id, c.agent_id, ch.status, ch.title, ch.attempt FROM claims c JOIN changes ch ON ch.id = c.change_id WHERE c.lease_expires < ?", now).toArray();
    for (const r of expired) {
      if (String(r.status) !== "claimed") continue; // submitted work no longer needs the lease
      const next: ChangeStatus = Number(r.attempt) >= MAX_ATTEMPTS ? "failed" : "open";
      await this.endClaim(String(r.change_id), "expired", "lease expired before the agent submitted", next, false);
      this.sql.exec("UPDATE agents SET status = 'expired', last_seen = ? WHERE id = ?", now, String(r.agent_id));
      this.bump("expired");
      this.event("expired", { change_id: String(r.change_id), title: String(r.title), agent: String(r.agent_id) });
    }
    const remaining = this.sql.exec("SELECT MIN(lease_expires) AS t FROM claims").toArray()[0];
    if (remaining && remaining.t != null) await this.ctx.storage.setAlarm(Math.max(now + 2000, Math.min(Number(remaining.t) + 500, now + 15_000)));
  }

  // ---- websockets ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "hello", stats: this.stats() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Coordinator", { status: 200 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
