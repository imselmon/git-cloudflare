# Submission form answers

Form: https://www.cloudflare.com/git-competition/submit · closes October 14, 11:59 PM PDT (October 15, 12:29 PM IST). Video upload is direct (MP4 up to 2 GiB): use `~/Downloads/braid-demo.mp4`.

## Your team

Fill these yourself (the rules require a legal resident of the US, Canada, UK, Australia, South Africa or Finland, and finalists present in person in San Francisco on October 21):

- Team name: **Braid**
- Primary contact name / email: you
- Team location: your city and country of legal residence
- First attendee name / email: you
- Second attendee: optional

## Project name

Braid

## Project vision

Git assumes the person who wrote a change is expensive to ask twice. That is why branches live long, conflicts are merged by hand, and review means a human reading a diff. Agents break that assumption: redoing work costs pennies. Braid is version control built on that fact. The unit of change is an intent, not a pull request: a goal, a declared scope of files, and an acceptance note; the diff is just the current attempt. Every attempt gets its own strand, a real Artifacts fork with its own tokens and rate budget. The lease is the token: claiming a change mints a write token whose TTL is the lease, so a stalled agent's token expires and a rogue agent's token is revoked, and either way its next push is a 403. File-disjoint work lands in parallel through a batched, single-writer trunk; manifests get a structural union merge. A true conflict is never merged by hand: the change is replayed on the new trunk. Review checks each diff against its own intent, and every trunk commit carries the change, agent, model, reviewer verdict and replay chain as git trailers and notes. Thousands of agents, no merge markers, full provenance.

## How you used Cloudflare

Artifacts is the substrate. A trunk repo plus one forked repo per attempt (1,000 in the demo), created with create and fork. Repo-scoped write tokens with TTLs act as leases, revokeToken is the kill switch, and read-only tokens go to reviewers and the dashboard. readCommit and readTree give a clone-free Merkle diff of each strand against its base for scope enforcement, readBlob feeds the three-way merge, readFile serves live previews of trunk, any commit or any strand with no build step, and log powers the history views. Git smart-HTTP is the only write path: isomorphic-git inside Workers for Braid's own agents and plain git for external ones. Workers host the API (routed with Blaze, our zero-dependency Express-style framework for Workers), the dashboard on Static Assets, and an MCP server so any coding agent joins with one line. Durable Objects provide a linearizable Coordinator (SQLite, WebSocket hibernation, alarms for lease expiry), one AgentRunner per agent, and a single-writer Integrator that batches trunk pushes. Workers AI runs the editing agents (GLM-5.3-Flash) and the reviewer (Llama 4 Scout).

## Demo video

Upload `braid-demo.mp4` (6 min 48 s, 1080p, 53 MB).

## Open source repository URL

https://github.com/imselmon/git-cloudflare

## Instructions to run your project

Live demo: https://braid.monarc.workers.dev (press "Spawn 8 agents"; "Force a conflict" shows a replay; "Swarm 1,000 bots" shows scale).

To run your own copy you need a Cloudflare account on the Workers Paid plan (Artifacts requires it), Node 22 and pnpm:

git clone https://github.com/imselmon/git-cloudflare braid && cd braid
pnpm install
npx wrangler login
pnpm run deploy
curl -X POST https://braid.<your-subdomain>.workers.dev/api/project/init -H 'content-type: application/json' -d '{"force":true}'

Open the printed URL and press "Spawn 8 agents". Optional: connect Claude Code with `claude mcp add --transport http braid https://braid.<your-subdomain>.workers.dev/mcp`, or run `scripts/demo.sh https://braid.<your-subdomain>.workers.dev` for the plain-git path. The README has the architecture, the API and the honest scale notes; DEMO.md has the video script.

## Checkboxes

Both must be ticked: built with Workers and Artifacts; agree to the terms and privacy policy.
