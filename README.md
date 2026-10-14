<p align="center"><img src="public/brand/braid-wordmark.svg" alt="Braid" height="48"></p>

<h3 align="center">Version control for agent swarms. Agents ship intents, not pull requests.</h3>

<p align="center">Built on Cloudflare Workers, Durable Objects, Workers AI and <b>Artifacts</b> for the <a href="https://www.cloudflare.com/git-competition/">Build the next GitHub</a> challenge.</p>

---

Git assumes the person who wrote a change is expensive to ask twice. That is why branches live long, conflicts are merged by hand, and review means a human reading a diff. **Agents break that assumption: redoing work costs pennies.** Braid is version control built on that fact.

| Git / GitHub | Braid |
|---|---|
| A pull request is a diff waiting for a human | A **change** is an intent: a goal, a declared **scope** of files, and an acceptance note. The diff is just the current attempt. |
| Branches share one repo and one rate limit | Every attempt gets its own **strand**: an Artifacts fork of trunk, with its own tokens and its own rate budget. |
| Access is a permission that outlives the task | The **lease is the token**. Claiming a change mints a write token whose TTL is the lease. A stalled agent's token expires; a rogue agent's token is revoked. Either way its next `git push` is a 403. |
| Conflicts are resolved by hand | File-disjoint work lands in parallel. Clean three-way merges land automatically, and manifests get a structural JSON union merge. A true conflict is **replayed**: the change goes back to an agent with a hint and is redone on the new trunk. Merge markers never exist. |
| Review reads the diff | Review checks the diff **against its own intent**: a deterministic scope check rejects anything outside the declared files, then a model answers "does this do what the change says, and nothing more?" |
| History is a list of commits | Every trunk commit carries `Change-Id`, `Agent`, `Scope`, `Merge`, `Reviewed-By`, `Replay-Of` and `Weave` trailers, plus a git note with the full context. `git clone` keeps all of it. |

## What you can do in the demo

Open the dashboard and press **Spawn 8 agents**. Eight Workers AI agents (GLM-5.3-Flash) claim changes from the backlog, each in its own strand, and the Loom Conf website on the right updates live as changes land. Press **Swarm 1,000 bots** and a thousand agents each fork trunk, add a sponsor to the same `sponsors.json`, push, and land through union merges, a few hundred per minute, one trunk push per weave.

- **Claims mode** holds back changes whose scope overlaps an active claim (prevention). **Optimistic mode** lets everyone claim anything and replays the losers (recovery). Flip the switch while agents run.
- Click an agent and **revoke** it: the token dies that instant.
- Click a change to see every attempt, its strand (with a live preview of that strand's site), the reviewer's verdict, and why it landed, replayed or was rejected.
- The **Code** tab is a file browser over any ref: trunk, a commit, or an agent's strand. Every byte is read from Artifacts, no clone. Each file has a **Why this file?** button that lists the changes, agents, models and reviews that shaped it.
- The **Commits** tab reads history straight from Artifacts. A commit page shows the diff, the provenance trailers, Braid's record of the intent, rationale and review, and the git note. Links are shareable (`#code/main/sections/hero.html`, `#commit/<sha>`, `#change/<id>`).

## Connect your own agent

Braid speaks MCP. One line for Claude Code:

```bash
claude mcp add --transport http braid https://braid.monarc.workers.dev/mcp
```

Then: `claim_change` gives you a strand, a lease token and a ready-made `git clone` command; edit inside the scope; `git push origin HEAD:main`; `submit_change`. Braid does the rest. The same flow works with curl and plain git: see [`scripts/demo.sh`](scripts/demo.sh).

## How it uses Cloudflare

```
 dashboard ──ws──┐                                   ┌──────────── Artifacts namespace "braid" ─────────────┐
 Claude Code ─mcp┤   Worker (Blaze router)           │  trunk-xxxx            strand-<change>-<n>  × N        │
 plain git ──────┼──────────────────────────────────►│  (one writer)          (one per attempt)               │
                 │                                   └───────────▲───────────────────▲──────────────────────┘
                 │   Coordinator DO ─── claim: fork + mint token ┘                   │ clone / push with lease token
                 │   (SQLite, WebSockets, alarms)                                    │
                 │        │ submit                                                   │
                 │        ▼                                                          │
                 │   Integrator DO ── Merkle diff via readCommit/readTree ──────────┘
                 │   (sole trunk writer)  scope check · review (Workers AI) · 3-way merge · trailers + notes · one push per weave
                 │
                 │   AgentRunner DO × N ── Workers AI edits, or synthetic edits for scale
                 └── /site/<ref>/… live preview of any ref via readFile, no build step
```

| Artifacts feature | Where Braid uses it |
|---|---|
| `create` + git push (isomorphic-git in a Worker) | Seeding trunk |
| `fork(…, {defaultBranchOnly})` | One strand per attempt |
| `createToken(scope, ttl)` / `revokeToken` | The lease and the kill switch; reviewers and the dashboard get read tokens |
| `readCommit` + `readTree` | Clone-free Merkle diff of a strand against its base: the cost scales with the change, not the repo |
| `readBlob` / `readFile({ref, path})` | Three-way merge inputs; live previews of trunk, any commit, or any strand |
| `log` | Trunk history with provenance trailers, no clone |
| git smart-HTTP | Agents push to strands; the Integrator pushes trunk and `refs/notes/braid` |

Workers host the API, dashboard (Static Assets) and MCP endpoint. Durable Objects give a linearizable Coordinator (claims are reserved synchronously, so two agents can never take overlapping scopes in claims mode), one AgentRunner per agent, and a single-writer Integrator that batches trunk pushes. Workers AI runs the editing agents (GLM-5.3-Flash) and the reviewer (Llama 4 Scout).

## Run it yourself

Requires a Cloudflare account on the Workers Paid plan (Artifacts needs it), Node 22 and pnpm.

```bash
git clone https://github.com/imselmon/git-cloudflare braid && cd braid
pnpm install
npx wrangler login
pnpm run deploy                     # prints https://braid.<your-subdomain>.workers.dev
curl -X POST https://braid.<your-subdomain>.workers.dev/api/project/init -d '{"force":true}'
```

Open the URL, press **Spawn 8 agents**, and watch. Optional: `claude mcp add --transport http braid https://braid.<your-subdomain>.workers.dev/mcp`, or run `scripts/demo.sh https://braid.<your-subdomain>.workers.dev`.

The Artifacts namespace (`braid`) is created on first use. The demo site that agents edit lives in `src/seed/`; the backlog of changes is in `src/backlog.ts`.

## API

| Method and path | Purpose |
|---|---|
| `POST /api/project/init` `{force}` | Create and seed a fresh trunk and backlog |
| `GET /api/state` | Changes, agents, claims, stats, recent events |
| `POST /api/changes` `{title, body, scope[], accept}` | Propose a change |
| `POST /api/claim` `{agent, changeId?, lease?}` | Fork a strand and mint a lease token |
| `POST /api/renew` `{agent, changeId}` | Fresh token, longer lease |
| `POST /api/submit` `{agent, changeId, head_sha, summary, rationale}` | Queue the attempt for the next weave |
| `POST /api/release` / `POST /api/revoke` | Give a claim back / kill an agent's token |
| `POST /api/mode` `{mode: claims \| optimistic}` · `POST /api/review` `{enabled}` | Coordination settings |
| `POST /api/swarm` `{n, kind: llm \| synthetic}` · `POST /api/stop` | Spawn or stop agents |
| `GET /api/tree?ref&path`, `GET /api/file?ref&path`, `GET /api/commit/:sha` | Code browser and commit pages, read from Artifacts |
| `GET /api/log`, `GET /api/why?path=`, `GET /api/changes/:id`, `GET /api/attempts` | Provenance |
| `GET /site/main/…`, `/site/<sha>/…`, `/site/strand-…/…` | Live previews from Artifacts |
| `POST /mcp` | MCP server (streamable HTTP) |
| `GET /ws` | Dashboard event stream |

## Scale, honestly

What the demo really does: every one of the 1,000 bots forks a real Artifacts repo, clones it, commits, pushes with its own lease token and submits; the Integrator diffs each strand with binding reads and lands them 25 per weave with one trunk push per weave. What is not built: sharding. The design for 100,000 agents is one Coordinator per scope prefix, Artifacts namespaces as shards (each with its own control-plane budget), and a tree of integrators feeding trunk so trunk sees one push per module per weave. The name is the design: many strands, one rope.

## Layout

```
src/index.ts        Blaze router: API, /site previews, /mcp, /ws
src/coordinator.ts  Coordinator DO: backlog, claims, leases, events
src/integrator.ts   Integrator DO: Merkle diff, scope, review, merge, weave
src/agent.ts        AgentRunner DO: claim → clone → edit → push → submit
src/artifacts.ts    Binding helpers: retries, tree diff, scope matching
src/git.ts          isomorphic-git: clone, commit, push, notes
src/memory-fs.ts    In-memory fs for isomorphic-git
src/merge.ts        diff3 and JSON union merges
src/llm.ts          Workers AI prompts for editing and review
src/mcp.ts          MCP server
src/seed/           The Loom Conf demo site
public/             Dashboard (Braid design system)
```

MIT licensed. Fonts are IBM Plex (OFL).
