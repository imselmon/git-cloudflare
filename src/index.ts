/**
 * Braid: version control for agent swarms, on Cloudflare Workers + Artifacts.
 * This file is the HTTP edge: a Blaze app that routes to the Coordinator,
 * serves live previews of any ref straight out of Artifacts, exposes the MCP
 * endpoint and upgrades dashboard WebSockets.
 */
import { createApp, type Middleware } from "blazefw";
import { cors } from "blazefw/middleware/cors";
import { handleMcp } from "./mcp";
import { getRepo, mintToken } from "./artifacts";
import { BRANCH } from "./types";
import { parseTrailers } from "./git";
import { chat, extractText, REVIEW_MODEL } from "./llm";

export { Coordinator } from "./coordinator";
export { Integrator } from "./integrator";
export { AgentRunner } from "./agent";

const app = createApp<Env>();
app.use(cors({ origins: "*" }) as unknown as Middleware<Env>);

const coord = (env: Env) => env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
const body = async <T = Record<string, unknown>>(req: { json: <X>() => Promise<X> }): Promise<T> => {
  try {
    return await req.json<T>();
  } catch {
    return {} as T;
  }
};

app.get("/api/health", (_req, res) => res.json({ ok: true, name: "braid" }));
app.get("/api/state", async (req, res) => res.json(await coord(req.env).state()));
app.post("/api/project/init", async (req, res) => {
  const b = await body<{ force?: boolean }>(req);
  res.json(await coord(req.env).init({ force: Boolean(b.force) }));
});
app.get("/api/changes", async (req, res) => res.json(await coord(req.env).listChanges({ status: req.query.get("status") ?? undefined, limit: Number(req.query.get("limit") ?? 200) })));
app.post("/api/changes", async (req, res) => {
  const b = await body<{ title: string; body: string; scope: string[]; accept?: string; by?: string }>(req);
  res.json(await coord(req.env).createChange({ ...b, by: b.by ?? "api" }));
});
app.get("/api/changes/:id", async (req, res) => {
  const d = await coord(req.env).changeDetail({ id: req.params.id });
  if (!d) return res.json({ error: "not found" }, 404);
  res.json(d);
});
app.post("/api/claim", async (req, res) => {
  const b = await body<{ agent: string; changeId?: string; lease?: number; model?: string }>(req);
  res.json(await coord(req.env).claim({ agent: b.agent, kind: "external", changeId: b.changeId, lease: b.lease, model: b.model }));
});
app.post("/api/renew", async (req, res) => {
  const b = await body<{ agent: string; changeId: string; lease?: number }>(req);
  res.json(await coord(req.env).renew(b));
});
app.post("/api/submit", async (req, res) => {
  const b = await body<{ agent: string; changeId: string; head_sha: string; summary?: string; rationale?: string }>(req);
  res.json(await coord(req.env).submit(b));
});
app.post("/api/release", async (req, res) => {
  const b = await body<{ agent: string; changeId: string; reason?: string }>(req);
  res.json(await coord(req.env).release(b));
});
app.post("/api/revoke", async (req, res) => {
  const b = await body<{ agent: string }>(req);
  res.json(await coord(req.env).revoke(b));
});
app.post("/api/mode", async (req, res) => {
  const b = await body<{ mode: "claims" | "optimistic" }>(req);
  res.json(await coord(req.env).setMode({ mode: b.mode === "optimistic" ? "optimistic" : "claims" }));
});
app.post("/api/review", async (req, res) => {
  const b = await body<{ enabled: boolean }>(req);
  res.json(await coord(req.env).setReview({ enabled: Boolean(b.enabled) }));
});
app.post("/api/swarm", async (req, res) => {
  const b = await body<{ n: number; kind: "llm" | "synthetic"; model?: string; maxChanges?: number }>(req);
  res.json(await coord(req.env).swarm({ n: Number(b.n ?? 1), kind: b.kind === "synthetic" ? "synthetic" : "llm", model: b.model, maxChanges: b.maxChanges }));
});
app.post("/api/stop", async (req, res) => res.json(await coord(req.env).stopAll()));
app.post("/api/demo/conflict", async (req, res) => res.json(await coord(req.env).demoConflict()));
app.get("/api/attempts", async (req, res) => res.json(await coord(req.env).listAttempts({ outcome: req.query.get("outcome") ?? undefined, agent: req.query.get("agent") ?? undefined, limit: Number(req.query.get("limit") ?? 100) })));
app.get("/api/events", async (req, res) => res.json(await coord(req.env).listEvents({ kind: req.query.get("kind") ?? undefined, limit: Number(req.query.get("limit") ?? 200) })));
app.get("/api/why", async (req, res) => res.json(await coord(req.env).why({ path: req.query.get("path") ?? "" })));
app.get("/api/integrator", async (req, res) => res.json(await req.env.INTEGRATOR.get(req.env.INTEGRATOR.idFromName("main")).status()));
app.get("/api/trunk/token", async (req, res) => {
  const st = await coord(req.env).state();
  if (!st.settings.trunk_name) return res.json({ error: "project not initialised" }, 404);
  const tok = await mintToken(req.env.ARTIFACTS, st.settings.trunk_name, "read", 900);
  res.json({ trunk: st.settings.trunk_name, remote: st.settings.trunk_remote, sha: st.settings.trunk_sha, token: tok.plaintext, expires_at: tok.expiresAt, clone: `git -c http.extraHeader="Authorization: Bearer ${tok.plaintext}" clone "${st.settings.trunk_remote}" trunk` });
});

/** Trunk history straight from Artifacts, with provenance trailers parsed. */
app.get("/api/log", async (req, res) => {
  const st = await coord(req.env).state();
  if (!st.settings.trunk_name) return res.json([]);
  using repo = await getRepo(req.env.ARTIFACTS, st.settings.trunk_name, 2);
  const entries = await repo.log({ ref: req.query.get("ref") ?? BRANCH, limit: Math.min(200, Number(req.query.get("limit") ?? 40)) });
  res.json(entries.map((e) => ({ hash: e.hash, message: e.message, author: e.author, committedAt: e.committedAt, parents: e.parents, trailers: parseTrailers(e.message), title: e.message.split("\n")[0] })));
});

app.get("/api/agents/:id", async (req, res) => res.json(await req.env.AGENT.get(req.env.AGENT.idFromName(req.params.id)).status()));

/** Debug: see what a Workers AI model returns for a tiny review prompt. */
app.get("/api/debug/ai", async (req, res) => {
  const model = req.query.get("model") ?? REVIEW_MODEL;
  const messages = [
    { role: "system" as const, content: 'Reply with ONLY JSON: {"conforms": true|false, "risk": "low"|"medium"|"high", "notes": "<one sentence>"}.' },
    { role: "user" as const, content: "Change: add a FAQ section. Diff: +++ sections/faq.html\n+<h2>FAQ</h2>\n+<p>When? October.</p>" },
  ];
  const t0 = Date.now();
  const input: Record<string, unknown> = { messages, max_tokens: Number(req.query.get("max_tokens") ?? 800), temperature: 0.1 };
  if (req.query.get("json") !== "0") input.response_format = { type: "json_object" };
  try {
    const raw = await (req.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, input);
    res.json({ model, ms: Date.now() - t0, text: extractText(raw), raw });
  } catch (e) {
    res.json({ model, ms: Date.now() - t0, error: String((e as Error).message) });
  }
});

/** Debug: list a tree by hash to verify clone-free reads. */
app.get("/api/debug/tree", async (req, res) => {
  using repo = await getRepo(req.env.ARTIFACTS, req.query.get("repo") ?? "");
  const sha = req.query.get("sha") ?? "";
  const commit = await repo.readCommit(sha);
  const tree = commit ? await repo.readTree(commit.treeHash) : null;
  res.json({ commit, tree });
});

/** Dashboard event stream. */
app.get("/ws", async (req, res) => {
  const r = await coord(req.env).fetch(req.raw);
  res.raw(r);
});

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", ico: "image/x-icon", woff2: "font/woff2" };

/** Live preview of any ref, served straight from Artifacts with no build step.
 *  /site/main/…      trunk at its default branch
 *  /site/<sha>/…     trunk at a commit
 *  /site/strand-…/…  a strand (an agent's fork) at its main branch */
app.get("/site/*", async (req, res) => {
  const m = /^\/site\/([^/]+)\/?(.*)$/.exec(req.path);
  if (!m) return res.send("not found", 404);
  const [, refOrRepo, rest] = m;
  if (rest === "" && !req.path.endsWith("/")) return res.redirect(req.path + "/", 302);
  const path = rest === "" ? "index.html" : rest.endsWith("/") ? rest + "index.html" : rest;
  const st = await coord(req.env).state();
  const trunk = st.settings.trunk_name;
  if (!trunk) return res.send("Project not initialised. POST /api/project/init first.", 404);
  const isStrand = refOrRepo.startsWith("strand-");
  const repoName = isStrand ? refOrRepo : trunk;
  const ref = isStrand ? BRANCH : refOrRepo;
  try {
    using repo = await getRepo(req.env.ARTIFACTS, repoName, 2);
    const blob = await repo.readFile({ ref, path });
    if (!blob) return res.send(`No ${path} at ${refOrRepo}`, 404);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    res.header("Cache-Control", "no-store");
    res.header("X-Braid-Ref", ref);
    res.type(TYPES[ext] ?? blob.type ?? "application/octet-stream");
    res.send(await blob.arrayBuffer());
  } catch (e) {
    res.send(`Cannot read ${repoName}@${ref}: ${String((e as Error).message)}`, 404);
  }
});

app.all("/mcp", async (req, res) => res.raw(await handleMcp(req.raw, req.env, new URL(req.url).origin)));
app.all("/mcp/*", async (req, res) => res.raw(await handleMcp(req.raw, req.env, new URL(req.url).origin)));

app.onError((err, _req, res) => {
  console.error(err);
  res.json({ error: String((err as Error)?.message ?? err) }, 500);
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
