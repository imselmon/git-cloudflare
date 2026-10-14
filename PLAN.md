# Tributary: build plan

> **Agents ship intents, not pull requests.**
> Built on Cloudflare Workers, Durable Objects, Workers AI and **Artifacts** for the
> [Build the next GitHub](https://www.cloudflare.com/git-competition/) challenge.

**Hard deadline: Oct 14, 11:59 PM PDT (Oct 15, 12:29 PM IST).**
Submit through the web form: a 5–10 minute demo video, a public repo, and run instructions.

---

## 0. Before you start

- [ ] **Eligibility.** The rules limit entry to legal residents of the US, CA, UK, AU, ZA or FI, aged 18+. Confirm this before spending the night.
- [ ] **Login.** Run `npx wrangler@latest login`. The current OAuth token lacks the `artifacts:write` scope, so Artifacts returns 401.
- [ ] **Plan.** The account (`Imzainon@gmail.com's Account`, `55bcc804…`) must be on **Workers Paid**, which Artifacts requires.
- [ ] **Account ID.** Run `export CLOUDFLARE_ACCOUNT_ID=55bcc8041471b16802f4a9ddc5455705`. Wrangler is logged into about 20 accounts.
- [ ] **Disk.** Keep at least 3 GB free (`df -h /`). The disk was at 124 MB earlier tonight.
- [ ] **Repo visibility.** Make `github.com/imselmon/git-cloudflare` public before submitting. The MIT `LICENSE` is already in place.

---

## 1. The idea in 30 seconds

Git and GitHub assume the person who wrote a change is expensive to ask twice. So branches live long, conflicts are merged by hand, and review means a human reading a diff. **Agents break that assumption: redoing work costs pennies.**

Tributary is version control for an agent swarm, built on that fact:

1. **The intent is the unit of change, not the pull request.** An intent is a goal, a declared *scope* (the paths it may touch), and an acceptance note. The diff is just the current attempt at that intent.
2. **Each intent gets its own Artifacts repo (a "lane"),** forked from trunk. This is Cloudflare's own guidance: *"If you have 10,000 agents, create 10,000 repos."*
3. **The lease is the token.** Claiming an intent mints a write token whose TTL is the lease. A stalled agent's token expires and it physically cannot push. The kill switch is `revokeToken`. Coordination is enforced by capabilities, not by convention.
4. **Conflicts are replayed, not merged.** File-disjoint changes land directly, and a clean 3-way merge lands automatically. A true conflict triggers **replay**: the intent is re-executed on the new trunk, with the failed attempt passed in as a hint. Merge markers never exist.
5. **Review checks a change against its own intent.** Deterministic scope enforcement rejects any diff that touches undeclared paths. A reviewer model then checks that the diff does what the intent says and nothing more.
6. **Every line knows why it exists.** Trunk commits carry `Intent-Id`, `Agent`, `Model`, `Reviewed-By` and `Replay-Of` trailers, and full intent context goes into `refs/notes/intents`. The context travels with the repo, so a plain `git clone` keeps it.

**Stage line:** *"Agents can redo work for pennies — so we stopped merging text and started replaying intent."*

---

## 2. Vocabulary

| Term | Meaning | Backed by |
|---|---|---|
| **Trunk** | The canonical repo. Only the Integrator writes to it. | Artifacts repo `trunk` |
| **Intent** | `{title, body, scope: ["sections/faq.html", "site.json"], accept}` | Coordinator DO SQLite |
| **Lane** | A fork of trunk at `base_sha`, one per intent attempt | Artifacts `fork()` |
| **Lease** | A write token with TTL = lease length; renewing means minting a new one | `createToken("write", ttl)` and `revokeToken` |
| **Landing** | Integrator batches lanes, then makes one commit per intent and **one push per batch** | isomorphic-git in a DO |
| **Replay** | Re-running an intent on new trunk, as a fresh lane with attempt+1 | AgentRunner DO and Workers AI |
| **Mode** | `claims` (pessimistic: overlapping scopes queue) or `optimistic` (overlap allowed, conflicts replay) | Coordinator setting |

Example lifecycle: `open → claimed → submitted → checking (scope + review) → queued → landed`.
Side exits: `expired → open`, `rejected`, `conflict → replaying (attempt+1)`.

---

## 3. Architecture

```
                        ┌──────────────── Worker "tributary" ────────────────┐
 Browser dashboard ─ws──┤ /ws  /api/*  /site/:ref/*  /mcp                    │
 Claude Code (MCP) ─────┤                                                     │
 plain git ──(token)────┼──────────────► Artifacts git (lane repos)          │
                        │                                                     │
                        │  Coordinator DO (1 per project, SQLite)             │
                        │   intents · claims/leases · scheduler · stats · ws  │
                        │        │ dispatch                ▲ submit           │
                        │        ▼                         │                  │
                        │  AgentRunner DO (1 per agent) ───┘                  │
                        │   llm | synthetic: fork→clone→edit→commit→push      │
                        │        │                                            │
                        │        ▼ queued attempts                            │
                        │  Integrator DO (1 per trunk)                        │
                        │   Merkle diff via binding · scope check · review    │
                        │   3-way merge · replay · batch commit · push trunk  │
                        └────────────────────┬────────────────────────────────┘
                                             ▼
             Artifacts namespace "tributary": trunk + lane-<intent>-<attempt> × N
```

| Component | Priority | Notes |
|---|---|---|
| Worker router and static dashboard (`public/`) | MUST | Workers Static Assets. `run_worker_first` covers `/api/*`, `/ws`, `/site/*`, `/mcp`. |
| **Coordinator DO** | MUST | Single-threaded, so claims are linearizable. WebSocket Hibernation API for live fan-out. Alarms expire leases. |
| **AgentRunner DO** | MUST | Alarm-driven loop. `llm` mode uses Workers AI `@cf/zai-org/glm-5.3-flash`. `synthetic` mode makes deterministic edits for scale. |
| **Integrator DO** | MUST | Keeps trunk's working copy in a MemoryFS between batches and is trunk's only writer, so pushes never race. |
| Live preview `/site/:ref/*` | MUST | Serves any ref (trunk or a lane) straight from `repo.readFile({ref, path})`, with no build step. |
| Review model | SHOULD | `@cf/moonshotai/kimi-k2.7-code` returns JSON `{conforms, risk, notes}`. |
| MCP server `/mcp` | SHOULD | Lets any coding agent join with one line of config. Uses `agents` SDK (`createMcpHandler` / `McpAgent`). |
| git notes `refs/notes/intents` | SHOULD | isomorphic-git `addNote`, pushed with trunk. |
| `claims` / `optimistic` mode toggle | SHOULD | The demo moment that shows prevention versus replay. |
| Hierarchical integration (module integrators → trunk) | NICE | The 100k design. Explain it on stage; build it only if ahead of schedule. |
| Push-event trigger (`cf.artifacts.repo.pushed`) | NICE | The agent calls `/submit` anyway, so events are only an extra signal. |

---

## 4. Artifacts usage map (all of it essential)

| Call | Where | Why |
|---|---|---|
| `ARTIFACTS.create("trunk")` + isomorphic-git `init/add/commit/push` | `POST /api/project/init` | Seeds trunk with the demo site (`src/seed/`). |
| `trunkRepo.fork("lane-<id>-<n>", {defaultBranchOnly: true})` | Coordinator on claim | Gives each attempt an isolated repo with its own rate budget. Retry on `FORK_IN_PROGRESS` (10303). |
| `laneRepo.createToken("write", leaseSec)` | Coordinator on claim or renew | **Lease = token.** Returned to the agent alongside the `remote`. |
| `laneRepo.revokeToken(id)` | Kill switch / lease expiry | Pushes fail immediately, which we show live in the demo. |
| `createToken("read", 900)` | Reviewer / external inspection | The reviewer can read but cannot write. |
| `repo.log({ref: "main", limit: 1})` | Integrator | Verifies the lane head the agent reported. |
| `readCommit` → `readTree` (recursive, skipping equal subtree SHAs) | Integrator | **Server-side Merkle diff** to find the changed paths, which drives scope enforcement with no clone. |
| `readFile({ref, path})` / `readBlob(sha)` | Integrator and `/site/:ref/*` | Fetches base, lane and trunk versions for the 3-way merge, and serves the live previews. |
| git smart-HTTP push (isomorphic-git, `onAuth` with the token secret) | AgentRunner, Integrator | The only write path. Lanes take one push per attempt; trunk takes one push per batch. |
| Plain `git clone/push` with `http.extraHeader="Authorization: Bearer $TOKEN"` | External agents (Claude Code) | Proves lanes are ordinary git remotes. |
| `ARTIFACTS.delete(lane)` | After landing (SHOULD) | Lane lifecycle cleanup. |

Write path (from the docs' isomorphic-git example, plus a shallow clone):
`clone({depth: 1, singleBranch: true})` → `writeFile` → `add` → `commit` → `push({onAuth: () => ({username: "x", password: token.split("?expires=")[0]})})`.

---

## 5. Data model and API

### Coordinator SQLite

```sql
CREATE TABLE intents  (id TEXT PRIMARY KEY, title TEXT, body TEXT, scope TEXT /*json*/, accept TEXT,
                       status TEXT, attempt INT DEFAULT 0, created_by TEXT, created_at INT, updated_at INT);
CREATE TABLE claims   (intent_id TEXT PRIMARY KEY, agent_id TEXT, lane TEXT, remote TEXT, base_sha TEXT,
                       token_id TEXT, lease_expires INT);
CREATE TABLE attempts (id TEXT PRIMARY KEY, intent_id TEXT, n INT, agent_id TEXT, lane TEXT, base_sha TEXT,
                       head_sha TEXT, model TEXT, summary TEXT, rationale TEXT, review TEXT /*json*/,
                       outcome TEXT /* landed|auto-merged|replayed|rejected|expired */, created_at INT);
CREATE TABLE landed   (intent_id TEXT, trunk_sha TEXT, files TEXT /*json*/, mode TEXT, landed_at INT);
CREATE TABLE agents   (id TEXT PRIMARY KEY, kind TEXT /* llm|synthetic|external */, model TEXT, status TEXT, last_seen INT);
CREATE TABLE events   (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, kind TEXT, data TEXT);
```

### HTTP API

| Method and path | Purpose |
|---|---|
| `POST /api/project/init` | Create and seed trunk, then seed the intent backlog. |
| `GET  /api/state` | Snapshot of intents, agents, stats and recent events. |
| `POST /api/intents` | `{title, body, scope, accept}` → `{id}` |
| `POST /api/claim` | `{agent, intentId?}` → `{intent, lane, remote, token, base_sha, lease_expires}`. If the requested scope overlaps an active claim (in `claims` mode), the scheduler hands out the next non-conflicting intent instead. |
| `POST /api/renew` | `{intentId}` → a fresh token, extending the lease. |
| `POST /api/submit` | `{intentId, head_sha, summary, rationale}` → queued for the Integrator. |
| `POST /api/revoke` | `{agent}` kill switch: revoke the token and release the claim. |
| `POST /api/swarm` | `{n, kind: "llm" or "synthetic"}` spawns AgentRunner DOs. |
| `POST /api/mode` | `{mode: "claims" or "optimistic"}` |
| `GET  /api/why?path=` | Intents that shaped this file: agent, model, review and replay history. |
| `GET  /site/:ref/*` | Live preview from Artifacts. |
| `GET  /ws` | Dashboard event stream. |
| `/mcp` | Tools: `list_intents`, `propose_intent`, `claim_intent`, `renew_lease`, `submit_intent`, `why`. |

---

## 6. Repository layout

```
LICENSE  README.md  PLAN.md  package.json  tsconfig.json  wrangler.jsonc
src/index.ts         router: api, ws, site, mcp, assets
src/coordinator.ts   Coordinator DO (intents, scheduler, leases, ws, stats)
src/agent.ts         AgentRunner DO (llm + synthetic)
src/integrator.ts    Integrator DO (merkle diff, scope check, review, merge, replay, push)
src/artifacts.ts     fork/token/readFile/tree-diff helpers, retry on 10302/10303
src/git.ts           isomorphic-git clone/commit/push/notes on MemoryFS
src/memory-fs.ts     copied from the Artifacts isomorphic-git example
src/merge.ts         node-diff3 3-way merge + JSON union merge for site.json
src/llm.ts           prompts: edit, replay, review (JSON output)
src/mcp.ts           MCP tools
src/seed/            demo site: index.html, site.json, sections/*.html, styles/*.css, app.js
public/index.html    dashboard (vanilla JS, single file)
scripts/demo.sh      curl + plain-git walkthrough (external agent)
```

```jsonc
// wrangler.jsonc
{
  "name": "tributary",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "public", "binding": "ASSETS",
              "run_worker_first": ["/api/*", "/ws", "/site/*", "/mcp"] },
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "tributary" }],
  "ai": { "binding": "AI" },
  "durable_objects": { "bindings": [
    { "name": "COORDINATOR", "class_name": "Coordinator" },
    { "name": "INTEGRATOR",  "class_name": "Integrator" },
    { "name": "AGENT",       "class_name": "AgentRunner" } ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Coordinator", "Integrator", "AgentRunner"] }],
  "observability": { "enabled": true }
}
```

### Demo codebase (the trunk)

The trunk is a small conference-style website, so every landed change is *visible*:

- `index.html` is a loader that renders the sections listed in `site.json`.
- `sections/*.html` and `styles/*.css` hold one file per feature, so most intents are file-disjoint and run in parallel.
- `site.json` is the shared hot spot. Concurrent edits to it are union-merged, and real clashes trigger replay.

Seed backlog, about 30 intents: "Add FAQ section", "Sticky header", "Dark-mode toggle", "Speaker cards", "Translate hero to Spanish", "Countdown timer", "Accessibility pass on nav", and so on. Some are deliberately overlapping, for the conflict demo.

---

## 7. Integration algorithm (Integrator DO)

Every 2 seconds, or whenever a submit arrives, the Integrator takes up to `K = 25` queued attempts and processes each in turn:

1. **Diff.** `changed = merkleDiff(base_sha, head_sha)` using `readTree` and skipping equal SHAs.
2. **Scope.** If any `changed ⊄ scope`, reject with `scope-violation`. This step is deterministic and needs no model.
3. **Review.** The review model checks the diff against the intent and returns `{conforms, risk, notes}`. Low risk lands automatically; high risk is held for a human click.
4. **Merge.** For each changed file `f`, compare the trunk version `T(f)`, base `B(f)` and lane `L(f)`:
   - if `T(f) == B(f)`, take `L(f)` (**clean**);
   - otherwise `diff3(T, B, L)`; a clean result is **auto-merged**, and `site.json` uses a JSON union merge;
   - a conflict marks the intent **replay**: it returns to the Coordinator with attempt+1, `base = new trunk`, and the previous diff as a hint. No conflicted bytes ever reach trunk.
5. **Commit.** Each surviving intent gets its own commit with trailers:
   ```
   Add FAQ section

   Intent-Id: int_7f3a
   Agent: agent-042 (llm:@cf/zai-org/glm-5.3-flash)
   Reviewed-By: reviewer (@cf/moonshotai/kimi-k2.7-code) conforms=true risk=low
   Replay-Of: att_19c2   # only when replayed
   ```
6. **Push and broadcast.** One push per batch carries `main` and `refs/notes/intents`. The Coordinator then broadcasts `landed` events.

**Throughput:** trunk sees one push per batch, not one push per agent.

---

## 8. Scale story (honest)

| Layer | Demo, real | Path to 100k (stated, not built) |
|---|---|---|
| Agents | About 10 real LLM agents, plus **1,000 synthetic agents doing real git**: each gets a real Artifacts fork, a token, a clone, a commit and a push. | AgentRunner DOs scale horizontally. |
| Repos | 1,000+ real Artifacts lanes created live, with a counter in the UI. | Unlimited repos. Shard across namespaces, each with its own 2,000 req/10 s control-plane budget. |
| Coordination | One Coordinator DO. | Shard Coordinators by scope prefix (module); claims stay linearizable per shard. |
| Integration | One Integrator, batched. | A **tributary tree**: module integrators feed trunk, so trunk takes O(modules) pushes per batch. Hence the name. |

Rough cost: about 4 Artifacts operations per agent. 1,000 agents is about 4k operations, inside the 10k free tier. 100k agents is about $60 in operations.

---

## 9. Schedule (IST; deadline 12:29 PM IST)

All building happens in this Claude Code session: no subagents and no workflows.

| IST | What | Done when |
|---|---|---|
| **03:15–03:45** | **Setup and verify.** `wrangler login` → scaffold (`package.json`, `wrangler.jsonc`, `tsconfig`) → `pnpm add isomorphic-git node-diff3 agents` → `wrangler types`. Spike route: create `trunk`, push a seed commit, fork it, push to the fork, then `readFile`, `readTree`, `log`. Measure fork latency. Read the `ArtifactsCommitMetadata` and `TreeEntry` fields from the types. | The spike works against the real service. |
| 03:45–04:45 | `artifacts.ts`, `git.ts`, `memory-fs.ts`, seed site, Coordinator DO (schema, intents, claim with fork and token, submit, WebSocket). | `curl` claim → plain-git push → submit works end to end. |
| 04:45–05:45 | Integrator: Merkle diff, scope check, clean and auto-merge path, trailers, batch push. `/site/:ref/*` preview. | Landed changes show up on `/site/main/`. |
| 05:45–06:30 | AgentRunner (LLM and synthetic), Workers AI edit prompt, `/api/swarm`. Bare dashboard: board, counters, preview iframe. **Checkpoint: minimum demo slice.** | 10 LLM agents land changes with nobody touching the keyboard. |
| 06:30–07:30 | Replay on conflict, review model, leases (alarm expiry, renew), revoke kill switch, mode toggle. | A forced conflict replays and lands; a revoked agent's push fails. |
| 07:30–08:15 | MCP endpoint, plus a Claude Code run that joins via MCP and pushes with plain git. `/api/why`, git notes. Synthetic swarm of 1,000. | Claude Code lands an intent; 1,000 lanes are visible. |
| 08:15–09:00 | Deploy to `*.workers.dev`, dashboard polish, README with quickstart, rehearse the demo twice. Commit and push. | The public URL works from a clean browser. |
| **09:00–10:30** | **Record and edit the video** (script in §11). Keep it to 7–8 minutes. | MP4 exported, under 2 GiB. |
| 10:30–11:15 | Make the repo public, fill in the form (§12), **submit**. | Confirmation received. |
| 11:15–12:29 | Buffer. | — |

### Cut lines (drop in this order)

1. Hierarchical integration
2. Push-event trigger
3. git notes (keep the trailers)
4. Mode toggle
5. `/api/why` UI (keep the trailers plus `git log`)
6. The review model (keep the deterministic scope check)
7. MCP (fall back to `scripts/demo.sh` with plain git)

**Never cut:** fork per lane, lease = token, the replay path, batched trunk push, live preview, the 1,000-repo swarm.

### Risks and fallbacks

| Risk | Fallback |
|---|---|
| Artifacts still returns 401 or 403 after login: no Workers Paid, or beta gating | Try the `Imselmon` or `Sas8888salman` accounts. Otherwise create an API token with Artifacts Read/Edit in the dashboard and use REST. |
| Forks are slow or async (`forking` status) | Pre-warm a pool of lanes, or fall back to `create` + push of trunk's tree, which is a single shallow push. |
| isomorphic-git CPU or memory limits in DOs | Keep the demo repo tiny (under 200 KB), always use `depth: 1`, raise `limits.cpu_ms`. |
| Workers AI latency or quality | Use `glm-5.3-flash` for edits; keep intents small (one or two files); have synthetic agents carry the scale demo. |
| `using` declarations rejected by the bundler | `try { … } finally { repo[Symbol.dispose]() }` |
| The disk fills up again | `npm cache clean --force`; avoid installing several wrangler versions. |
| The video runs long | Record per-section clips; the §11 script already has timestamps. |

---

## 10. Judging rubric self-check

| Criterion (weight) | How Tributary scores |
|---|---|
| **Originality and quality (50%)** | Intents instead of PRs. **Replay instead of merge**, which is only possible because agents are cheap to re-run. Leases enforced *by Artifacts tokens*. Review against the intent. Provenance inside git. |
| **Concurrency, coordination, context, review, conflicts (25%)** | Linearizable scope claims (prevention); batched single-writer trunk (throughput); token-TTL leases (liveness); 3-way merge then replay (conflicts); deterministic scope check plus a reviewer (review); trailers, notes and `why` (context). |
| **Ease of use and UX (25%)** | Any coding agent joins with one MCP line. Plain git works. A live board, a live site preview for every ref, a one-click kill switch, and a one-click swarm. |

---

## 11. Demo video script (target 7:30)

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:30 | Title card, then the live dashboard with 1,000 lanes ticking | "A hundred thousand agents, one codebase. Git was designed for people who can't redo their work. Agents can." |
| 0:30–1:30 | Concept diagram (§3) | Intent, lane, lease = token, replay, review, provenance. |
| 1:30–3:00 | Click "Spawn 10 LLM agents". The board flows, the site preview updates live, and `site.json` edits auto-merge. | "Every intent gets its own Artifacts repo. Trunk only takes batched pushes from one integrator." |
| 3:00–3:45 | A forced conflict: two intents rewrite the hero. The second one shows **REPLAYING** and lands. | "No merge markers. We replay the intent on the new trunk." |
| 3:45–4:45 | Claude Code with a one-line MCP config: `claim_intent` → `git push` to its lane → `submit_intent` → lands | "Any agent, plain git, one line of config." |
| 4:45–5:30 | Scope violation rejected. Kill switch: revoke → the agent's `git push` fails with 401 live. | "The lease is the token. Coordination enforced by capabilities." |
| 5:30–6:30 | Spawn 1,000 synthetic agents. Counters show repos created, landed per minute, conflicts prevented, auto-merged and replayed. Flip claims ↔ optimistic. | "1,000 real Artifacts repos in about a minute. Here's how it shards to 100k." |
| 6:30–7:15 | Click a section → `why` → intent, agent, model, review, replay chain. Terminal: `git clone` trunk, `git log` with trailers, `git notes`. | "The context travels with the repo." |
| 7:15–7:30 | Architecture slide and close | "Tributary: agents ship intents, not pull requests." |

---

## 12. Submission form drafts

**Project name:** Tributary

**Project vision (about 150 words):**
Git assumes the author of a change is expensive to ask twice, which is why we have long-lived branches, hand-resolved conflicts and humans reading diffs. Agents break that assumption, because re-running work costs pennies. Tributary is version control built on that fact. The unit of change is an *intent* (a goal plus a declared scope), not a pull request. Every intent attempt gets its own Artifacts repo, and its lease *is* a scoped write token: when the token expires or is revoked, the agent physically cannot push. File-disjoint work lands in parallel through a batched single-writer trunk. A true conflict is never merged by hand: the intent is *replayed* on the new trunk. Review checks each diff against its own intent and scope, and every trunk commit carries its intent, agent, model and review as git trailers and notes. Thousands of agents, no merge markers, and full provenance.

**How you used Cloudflare (about 150 words):**
Artifacts is the substrate. A trunk repo plus one forked repo per intent attempt (1,000+ in the demo). Repo-scoped write tokens with TTLs act as leases, `revokeToken` is the kill switch, and read-only tokens go to reviewers. `readCommit`/`readTree` give a server-side Merkle diff for scope enforcement without cloning, `readFile` serves live previews of any ref, and git smart-HTTP (isomorphic-git inside Workers, plain git outside) is the write path. Workers host the API, the dashboard (Static Assets) and an MCP server. Durable Objects provide a linearizable Coordinator (SQLite, WebSocket Hibernation, alarms for lease expiry), an AgentRunner per agent, and a single-writer Integrator that batches trunk pushes. Workers AI powers the edit, replay and review agents (GLM-5.3-Flash, Kimi K2.7 Code).

**Instructions to run:**
```bash
git clone https://github.com/imselmon/git-cloudflare && cd git-cloudflare
pnpm install
npx wrangler login                  # account on Workers Paid (Artifacts)
pnpm run deploy                     # wrangler deploy
curl -X POST https://<your-worker>.workers.dev/api/project/init
open https://<your-worker>.workers.dev   # click "Spawn agents"
# Optional: connect Claude Code
claude mcp add --transport http tributary https://<your-worker>.workers.dev/mcp
```
The live demo URL goes in the README.

---

## 13. README outline

1. Hero line, a GIF of the dashboard, and the live URL.
2. Why: the 30-second idea (§1).
3. Concepts table (§2).
4. Quickstart: deploy, connect Claude Code via MCP, run `scripts/demo.sh` for plain git.
5. Architecture diagram and Artifacts usage map (§3, §4).
6. Scale: what is real in the demo and the path to 100k (§8).
7. Limitations, honestly stated, and the MIT license.
