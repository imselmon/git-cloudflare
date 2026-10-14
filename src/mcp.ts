/**
 * A minimal Model Context Protocol server over streamable HTTP (JSON-RPC 2.0,
 * JSON responses, no server-initiated streams). Any coding agent can join a
 * Braid project with one line of config and then use plain git on its strand.
 */
import type { Coordinator } from "./coordinator";
import { mintToken } from "./artifacts";

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> };

const TOOLS = [
  { name: "list_changes", description: "List changes (Braid's unit of work: an intent with a declared file scope). Optional status filter: open, claimed, queued, landed, rejected, failed.", inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" } } } },
  { name: "propose_change", description: "Propose a new change: a title, what to do, the exact files it may touch (scope) and an acceptance note.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, scope: { type: "array", items: { type: "string" } }, accept: { type: "string" } }, required: ["title", "body", "scope"] } },
  { name: "claim_change", description: "Claim a change for an agent. Returns a private strand (a forked git repo), a write token whose TTL is your lease, the base commit, and a ready-to-run git clone command. Omit change_id to take the next claimable change.", inputSchema: { type: "object", properties: { agent: { type: "string" }, change_id: { type: "string" }, lease_seconds: { type: "number" } }, required: ["agent"] } },
  { name: "renew_lease", description: "Mint a fresh token for a claim you hold, extending the lease.", inputSchema: { type: "object", properties: { agent: { type: "string" }, change_id: { type: "string" } }, required: ["agent", "change_id"] } },
  { name: "submit_change", description: "After pushing your commit to the strand's main branch, submit it for integration. Braid checks scope, reviews the diff against the intent, three-way merges onto trunk, and replays on conflict.", inputSchema: { type: "object", properties: { agent: { type: "string" }, change_id: { type: "string" }, head_sha: { type: "string" }, summary: { type: "string" }, rationale: { type: "string" } }, required: ["agent", "change_id", "head_sha"] } },
  { name: "release_change", description: "Give a claim back without submitting.", inputSchema: { type: "object", properties: { agent: { type: "string" }, change_id: { type: "string" }, reason: { type: "string" } }, required: ["agent", "change_id"] } },
  { name: "change_status", description: "Show a change with all its attempts, outcomes and reviews.", inputSchema: { type: "object", properties: { change_id: { type: "string" } }, required: ["change_id"] } },
  { name: "why", description: "Explain why a file on trunk looks the way it does: the changes, agents, models and reviews that shaped it.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "trunk", description: "Trunk status plus a short-lived read-only token and clone command for inspecting trunk.", inputSchema: { type: "object", properties: {} } },
];

function text(v: unknown) {
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] };
}

export async function handleMcp(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method === "GET") return new Response("Braid MCP: POST JSON-RPC here. Streams are not used.", { status: 405, headers: { Allow: "POST, DELETE" } });
  if (request.method === "DELETE") return new Response(null, { status: 200 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: Rpc | Rpc[];
  try {
    body = (await request.json()) as Rpc | Rpc[];
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const coord = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  const msgs = Array.isArray(body) ? body : [body];
  const replies: unknown[] = [];
  for (const m of msgs) {
    if (m.id === undefined || m.id === null) continue; // notification
    try {
      replies.push({ jsonrpc: "2.0", id: m.id, result: await dispatch(m, coord, env, origin) });
    } catch (e) {
      replies.push({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: String((e as Error).message) } });
    }
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

async function dispatch(m: Rpc, coord: DurableObjectStub<Coordinator>, env: Env, origin: string): Promise<unknown> {
  const p = (m.params ?? {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize":
      return { protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "braid", version: "0.1.0" }, instructions: "Braid is version control for agent swarms. Claim a change, clone the strand it gives you, commit, push to main, then submit. Keep inside the declared scope." };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(String(p.name), (p.arguments ?? {}) as Record<string, unknown>, coord, env, origin);
    default:
      throw new Error(`unknown method ${m.method}`);
  }
}

async function callTool(name: string, a: Record<string, unknown>, coord: DurableObjectStub<Coordinator>, env: Env, origin: string): Promise<unknown> {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  switch (name) {
    case "list_changes":
      return text(await coord.listChanges({ status: s("status"), limit: typeof a.limit === "number" ? a.limit : 50 }));
    case "propose_change":
      return text(await coord.createChange({ title: s("title") ?? "", body: s("body") ?? "", scope: Array.isArray(a.scope) ? (a.scope as string[]) : [], accept: s("accept") ?? "", kind: "any", by: "mcp" }));
    case "claim_change": {
      const r = await coord.claim({ agent: s("agent") ?? "mcp-agent", kind: "external", changeId: s("change_id"), lease: typeof a.lease_seconds === "number" ? a.lease_seconds : 900 });
      if (!r.change) return text(r);
      return text({
        ...r,
        how_to: [
          `git -c http.extraHeader="Authorization: Bearer ${r.token}" clone "${r.remote}" strand && cd strand`,
          `# edit only: ${r.change.scope.join(", ")}`,
          `git commit -am "${r.change.title}"`,
          `git -c http.extraHeader="Authorization: Bearer ${r.token}" push origin HEAD:main`,
          `# then call submit_change with head_sha=$(git rev-parse HEAD)`,
        ],
        lease_note: `Your token expires at ${new Date(r.lease_expires).toISOString()}. Call renew_lease to extend it. After it expires or is revoked, pushes fail.`,
        preview: `${origin}/site/${r.strand}/`,
      });
    }
    case "renew_lease":
      return text(await coord.renew({ changeId: s("change_id") ?? "", agent: s("agent") ?? "" }));
    case "submit_change":
      return text(await coord.submit({ changeId: s("change_id") ?? "", agent: s("agent") ?? "", head_sha: s("head_sha") ?? "", summary: s("summary"), rationale: s("rationale") }));
    case "release_change":
      return text(await coord.release({ changeId: s("change_id") ?? "", agent: s("agent") ?? "", reason: s("reason") }));
    case "change_status":
      return text(await coord.changeDetail({ id: s("change_id") ?? "" }));
    case "why":
      return text(await coord.why({ path: s("path") ?? "" }));
    case "trunk": {
      const st = await coord.state();
      const trunk = st.settings.trunk_name;
      if (!trunk) return text({ error: "project not initialised" });
      const tok = await mintToken(env.ARTIFACTS, trunk, "read", 900);
      return text({ trunk, sha: st.settings.trunk_sha, remote: st.settings.trunk_remote, live: `${origin}/site/main/`, clone: `git -c http.extraHeader="Authorization: Bearer ${tok.plaintext}" clone "${st.settings.trunk_remote}" trunk`, stats: st.stats });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
