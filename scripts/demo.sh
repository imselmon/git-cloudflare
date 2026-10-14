#!/usr/bin/env bash
# Braid demo from a terminal: claim a change over the HTTP API, work on it with
# plain git, push with the lease token, submit, and watch it land.
# Usage: scripts/demo.sh https://braid.<you>.workers.dev [agent-name]
set -euo pipefail
URL="${1:?usage: demo.sh <braid-url> [agent]}"
AGENT="${2:-terminal-agent}"
need() { command -v "$1" >/dev/null || { echo "need $1"; exit 1; }; }
need curl; need git; need python3

echo "1. Claim the next change for $AGENT"
CLAIM=$(curl -sf -X POST "$URL/api/claim" -H 'content-type: application/json' -d "{\"agent\":\"$AGENT\",\"lease\":900}")
python3 -c "import sys,json; d=json.loads(sys.argv[1]); assert d.get('change'), d; print('   ', d['change']['title']); print('    scope:', ', '.join(d['change']['scope'])); print('    strand:', d['strand'])" "$CLAIM"
CH=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['change']['id'])" "$CLAIM")
REMOTE=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['remote'])" "$CLAIM")
TOKEN=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['token'])" "$CLAIM")
FILE=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['change']['scope'][0])" "$CLAIM")

echo "2. Clone the strand with the lease token (plain git, Bearer header)"
WORK=$(mktemp -d)
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone -q "$REMOTE" "$WORK/strand"
cd "$WORK/strand"

echo "3. Edit inside the scope ($FILE) and push"
mkdir -p "$(dirname "$FILE")"
printf '\n<!-- %s was here, via plain git through Braid -->\n' "$AGENT" >> "$FILE"
git add "$FILE"
git -c user.name="$AGENT" -c user.email="$AGENT@agents.braid.dev" commit -q -m "Touch $FILE from the terminal"
git -c http.extraHeader="Authorization: Bearer $TOKEN" push -q origin HEAD:main
HEAD=$(git rev-parse HEAD)
echo "    pushed $HEAD"

echo "4. Submit for integration"
curl -sf -X POST "$URL/api/submit" -H 'content-type: application/json' -d "{\"agent\":\"$AGENT\",\"changeId\":\"$CH\",\"head_sha\":\"$HEAD\",\"summary\":\"Terminal edit\",\"rationale\":\"Demonstrates the plain-git path\"}" >/dev/null

echo "5. Wait for the weave"
for i in $(seq 1 30); do
  STATUS=$(curl -sf "$URL/api/changes/$CH" | python3 -c "import sys,json; d=json.load(sys.stdin); a=d['attempts'][-1]; print(d['change']['status'], a.get('outcome') or '', a.get('reason') or '')")
  case "$STATUS" in landed*|rejected*|failed*|open*) break;; esac
  sleep 2
done
echo "    $STATUS"
echo "6. Trunk history (clone-free, from Artifacts)"
curl -sf "$URL/api/log?limit=3" | python3 -c "import sys,json; [print('   ', e['hash'][:7], e['title'], '|', e['trailers'].get('Agent',''), '|', e['trailers'].get('Merge','')) for e in json.load(sys.stdin)]"
echo "Live site: $URL/site/main/"
