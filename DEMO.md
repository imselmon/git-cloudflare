# Braid demo: script and click path (target 7:30)

Live app: https://braid.monarc.workers.dev · Live site the agents edit: https://braid.monarc.workers.dev/site/main/

## Before recording

1. Open the dashboard and press **Reset project** (fresh trunk, 22 changes, empty sponsor wall). Wait for the preview to reload.
2. Make sure **Claims** and **Review on** are selected.
3. Have a terminal ready in an empty folder with `claude` installed. Run once beforehand:
   `claude mcp add --transport http braid https://braid.monarc.workers.dev/mcp`
4. Close the drawer, set the Changes filter to **All**, and keep the right-hand preview visible.

## Script

| Time | Do | Say |
|---|---|---|
| 0:00–0:30 | Title card, then the dashboard | Git assumes the person who wrote a change is expensive to ask twice. Branches live long, conflicts are merged by hand, review is a human reading a diff. Agents break that assumption: redoing work costs pennies. Braid is version control built on that fact. |
| 0:30–1:15 | Point at the rail copy, then a change row, then its scope in the drawer | Four ideas. A change is an intent with a declared scope of files, not a diff. Every attempt gets its own strand: a real Artifacts fork with its own tokens and its own rate limit. The lease is the token: claiming mints a write token whose TTL is the lease. And conflicts are replayed, never merged by hand. |
| 1:15–2:45 | Press **Spawn 8 agents**. Watch rows flip Working → Weaving → Landed, the preview update, "Held back" tick up, and union merges on site.json | Eight Workers AI agents claim changes. Each one forks trunk, edits only inside its scope, pushes with its lease token and submits. The Integrator is the only writer to trunk: it diffs each strand without cloning, using Artifacts' readCommit and readTree, checks the scope, asks a reviewer whether the diff does what the intent says, three-way merges, and pushes once per weave. Those five changes all touched site.json: the manifest got a structural union merge. And "Held back" is claims mode: overlapping scopes wait their turn. |
| 2:45–3:45 | Press **Force a conflict**. Watch one headline change land, the other show **Replaying**, then land. Open the drawer on it: attempt 1 replay, attempt 2 landed. Show the hero in the preview | Now optimistic mode, two agents rewriting the same headline. The second one conflicts. Braid never writes merge markers: the change goes back with a hint and is replayed on the new trunk. Two attempts, one clean commit, full history of both. |
| 3:45–5:00 | Terminal: in Claude Code, ask it to claim a change via the braid MCP server, clone the strand, edit, push and submit. Switch back to the dashboard as it lands | Any coding agent can join with one line. Claude Code asks Braid for a change, gets a strand and a lease token, and uses plain git. Braid treats it exactly like its own agents: scope check, review, weave. |
| 5:00–5:40 | Agents tab: click a working agent, confirm revoke. Terminal: a push with its token fails with 403. Rows: the change goes back to Open | The lease is enforced by Artifacts, not by convention. Revoke an agent and its next push is a 403. Its change goes back to the pool. |
| 5:40–6:40 | Press **Swarm 1,000 bots**. Narrate the counters: strands made, auto-merged, weaves. Open the preview's Sponsors section as it fills | A thousand agents, each a real Artifacts fork, a real clone, a real push with its own lease token, all editing the same file. Union merges land them a few hundred a minute, one trunk push per weave. The same design shards to a hundred thousand: a coordinator per scope prefix, a namespace per shard, a tree of integrators feeding trunk. Many strands, one rope. |
| 6:40–7:15 | Code tab: browse `sections/`, open `hero.html`, press **Why this file?**. Commits tab: open the latest commit, show the diff, the trailers (Agent, Merge, Reviewed-By, Replay-Of, Weave) and the Braid record. Press **Show clone command**; in the terminal clone trunk and run `git log --format='%h %s%n%(trailers)' -3` and `git notes --ref braid show HEAD` | Every line on trunk knows why it exists. The intent, the agent, the model, the reviewer's verdict and the replay chain are in the commit itself and in git notes. Clone it anywhere and the context comes along. |
| 7:15–7:30 | Architecture slide (README diagram), close on the wordmark | Braid. Agents ship intents, not pull requests. Built on Workers, Durable Objects, Workers AI and Artifacts. |

## Useful commands during the demo

```bash
# What Claude Code will do, by hand with curl + git:
scripts/demo.sh https://braid.monarc.workers.dev my-laptop

# Trunk with provenance (read-only token, 15 minutes):
curl -s https://braid.monarc.workers.dev/api/trunk/token | python3 -c "import sys,json; print(json.load(sys.stdin)['clone'])"
cd trunk && git log --format='%h %s%n%(trailers)' -3 && git fetch origin 'refs/notes/*:refs/notes/*' && git notes --ref braid show HEAD
```

## If something stalls

- A change stuck in Working: its lease expires within five minutes and it returns to Open. Or click the agent and revoke it.
- Nothing claimable: the backlog is finished. Press **Propose a change** or **Reset project**.
- Model slow: the agents time out after 75 s and fall back to a faster model on the third try.

## Regenerating the demo video

The video in the submission was produced by `demo/`: Playwright records the live dashboard and the HTML cards in `demo/cards/`, macOS `say` reads `demo/narration.json`, and ffmpeg assembles 1080p30 H.264 with burned-in captions and an `.srt` sidecar.

```bash
cd demo && npm install && npx playwright install chromium
python3 - <<'PY'
import json, subprocess
for k, t in json.load(open("narration.json")).items():
    subprocess.run(["say", "-v", "Samantha", "-r", "178", "-o", f"out/audio/{k}.aiff", t], check=True)
PY
node record.mjs        # resets the live project and records every scene (about 10 minutes)
node build.mjs         # writes out/braid-demo.mp4 and out/braid-demo.srt
```
