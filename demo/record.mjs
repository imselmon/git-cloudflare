// Records the demo scenes: HTML cards and the live Braid dashboard, driven by
// Playwright with video capture. Output: demo/out/raw/<scene>.webm
// Usage: node record.mjs [scene ...]   (no args = all scenes, in order)
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";

const BASE = process.env.BRAID_URL ?? "https://braid.monarc.workers.dev";
const OUT = new URL("./out/raw/", import.meta.url).pathname;
const CARDS = new URL("./cards/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const only = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return r.json();
};

async function record(name, seconds, fn) {
  if (only.size && !only.has(name)) return;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const t0 = Date.now();
  try {
    await fn(page);
  } catch (e) {
    console.error(`[${name}]`, e.message);
  }
  const remaining = seconds * 1000 - (Date.now() - t0);
  if (remaining > 0) await page.waitForTimeout(remaining);
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  await browser.close();
  renameSync(path, `${OUT}${name}.webm`);
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const card = (file) => async (page) => { await page.goto(`file://${CARDS}${file}`); };
const DIRECTOR = new URL("./director.js", import.meta.url).pathname;
const dash = async (page, hash = "") => { await page.goto(`${BASE}/?v=${Date.now()}${hash}`, { waitUntil: "domcontentloaded" }); await page.waitForSelector(hash.startsWith("#code") ? "#tree .bd-row" : "#changes .bd-row, #changes .empty"); await page.addScriptTag({ path: DIRECTOR }); await sleep(1500); };
const dir = (page, fn, ...args) => page.evaluate(([f, a]) => (window.__dir ? window.__dir[f](...a) : false), [fn, args]).catch(() => false);
/** Same as dir("point"/"zoom") but for a Playwright locator: resolves it to the element inside the page. */
const dirAt = (locator, fn, ...args) => locator.first().evaluate((el, [f, a]) => (window.__dir ? window.__dir[f](el, ...a) : false), [fn, args]).catch(() => false);
/** Point at the first change row whose badge has the given status. */
const rowWith = (page, status) => page.locator("#changes .bd-row", { has: page.locator(`.bd-badge[data-status=${status}]`) }).first();
const closeDrawer = async (page) => { await page.keyboard.press("Escape"); await sleep(400); };
const stateUntil = async (pred, maxMs) => { const t0 = Date.now(); for (;;) { const s = await api("/api/state"); if (pred(s)) return s; if (Date.now() - t0 > maxMs) return s; await sleep(2000); } };

// ---- cards ----
await record("s01_title", 18, card("title.html"));
await record("s02_ideas", 25, card("ideas.html"));

// ---- live: fresh project, eight agents ----
if (!only.size || only.has("s03_spawn")) { await api("/api/project/init", { force: true }); await sleep(4000); }
await record("s03_spawn", 92, async (page) => {
  await dash(page);
  await dir(page, "title", "01", "Eight agents, one trunk");
  await sleep(1500);
  await dir(page, "point", ".preview", "The site lives in an Artifacts repo: trunk", 4500, "left");
  await sleep(4800);
  await dir(page, "point", "#changes", "A backlog of changes: intents with a file scope", 3500, "right");
  await sleep(3800);
  await dir(page, "point", "#btn-llm", "Spawn 8 Workers AI agents", 3200, "right");
  await sleep(2200);
  await page.click("#btn-llm");
  await sleep(6000);
  await dir(page, "point", "#changes .bd-row:first-child .bd-code", "Each attempt gets its own strand: a real Artifacts fork", 5000, "bottom");
  await sleep(6000);
  await dir(page, "point", "#feed", "Claim → clone → edit → push → submit", 5000, "left");
  await sleep(9000);
  await dir(page, "point", "#stats", "Weaves: one trunk push per batch", 4500, "right");
  await sleep(10000);
  await dir(page, "zoom", ".preview", 1.5, 7000);
  await sleep(1200);
  await dir(page, "point", ".preview .bar", "Live from trunk, no build step", 4500, "bottom");
  await sleep(8500);
  await dir(page, "point", "#stats .stat:nth-child(6)", "Claims mode: overlapping scopes wait their turn", 5000, "right");
  await sleep(6000);
  const landed = rowWith(page, "merged");
  if (await landed.count()) {
    await dirAt(landed, "point", "Landed: diffed without a clone, reviewed, woven", 3500, "bottom");
    await sleep(3800);
    await landed.click();
    await sleep(2500);
    await dir(page, "point", "#drawer .attempt .kv", "Agent, strand, base → head → trunk, review verdict", 6000, "left");
    await dir(page, "zoom", "#drawer .attempt", 1.35, 6000);
    await sleep(8000);
    await closeDrawer(page);
  }
  await sleep(3000);
  await page.frameLocator("#preview").locator("body").evaluate((b) => b.scrollTo({ top: 600, behavior: "smooth" })).catch(() => {});
});

// ---- live: staged conflict and replay ----
await record("s04_conflict", 170, async (page) => {
  await dash(page);
  await dir(page, "title", "02", "A conflict, replayed");
  await sleep(1200);
  await dir(page, "point", "#btn-conflict", "Two agents will rewrite the same headline", 3500, "right");
  await sleep(2600);
  await page.click("#btn-conflict");
  await sleep(2500);
  await dir(page, "point", "#mode-seg", "Optimistic: anyone can claim anything", 4500, "right");
  const t0 = Date.now();
  await stateUntil((s) => s.events.some((e) => e.kind === "replay" && Date.now() - e.ts < 200000), 130000);
  const replaying = page.locator("#changes .bd-row", { has: page.locator(".bd-badge", { hasText: /Replay/i }) }).first();
  if (await replaying.count()) {
    await dirAt(replaying, "point", "Overlapping edit: no merge markers, the change is replayed", 6000, "bottom");
    await sleep(6500);
    await replaying.click();
    await sleep(2500);
    await dir(page, "point", "#drawer .attempt:first-of-type", "Attempt 1: conflicted on trunk", 5000, "left");
    await sleep(5500);
    await closeDrawer(page);
  }
  await stateUntil((s) => s.changes.some((c) => c.title === "Shorten the hero headline" && c.status === "landed") && s.changes.some((c) => /Loom Conf Lisbon/.test(c.title) && c.status === "landed"), Math.max(10000, 150000 - (Date.now() - t0)));
  await sleep(1500);
  await dir(page, "zoom", ".preview", 1.5, 6000);
  await dir(page, "point", ".preview", "Both changes landed, in order, with full history", 5500, "left");
  await sleep(7000);
});

// ---- card: MCP terminal ----
await record("s05_mcp", 30, card("terminal.html"));

// ---- live: revoke ----
if (!only.size || only.has("s06_revoke")) { await api("/api/swarm", { n: 2, kind: "llm", maxChanges: 1 }); await sleep(5000); }
await record("s06_revoke", 26, async (page) => {
  await dash(page);
  await dir(page, "title", "03", "The lease is the token");
  await page.click(".bd-tab[data-tab=agents]");
  await sleep(2000);
  const working = page.locator(".agent[data-status=working]").first();
  if (await working.count()) {
    await dirAt(working, "point", "Revoke this agent's lease", 3500, "bottom");
    await sleep(3800);
    await working.click();
    await sleep(2500);
    await dirAt(working, "point", "Token revoked: its next push is a 403", 5000, "bottom");
    await sleep(5500);
  }
  await page.click(".bd-tab[data-tab=changes]");
  await page.click("#filter-seg button[data-filter=trouble]").catch(() => {});
  await sleep(1500);
  await dir(page, "point", "#changes .bd-row:first-child", "Its change is back in the pool", 4500, "bottom");
  await sleep(5000);
});
await record("s06_term", 16, card("revoke.html"));

// ---- live: code and commits ----
await record("s08_code", 50, async (page) => {
  await dash(page, "#code/main/");
  await dir(page, "title", "05", "Every line knows why it exists");
  await sleep(1500);
  await dir(page, "point", "#ref-input", "Browse any ref: trunk, a commit, or a strand. No clone.", 4000, "bottom");
  await sleep(4500);
  await page.locator("#tree .bd-row", { hasText: "sections" }).first().click();
  await sleep(1800);
  await page.locator("#tree .bd-row", { hasText: "hero.html" }).first().click();
  await sleep(2500);
  await dir(page, "point", "#btn-why", "Why does this file look like this?", 3500, "bottom");
  await sleep(2500);
  await page.click("#btn-why").catch(() => {});
  await sleep(2000);
  await dir(page, "zoom", "#why", 1.4, 6000);
  await sleep(7500);
  await page.click(".bd-tab[data-tab=trunk]");
  await sleep(2500);
  await dir(page, "point", "#log .bd-row:first-child", "Trunk history from Artifacts, trailers parsed", 3500, "bottom");
  await sleep(3800);
  await page.locator("#log .bd-row").first().click();
  await sleep(3000);
  await dir(page, "point", "#drawer .kv", "Change-Id, Agent, Merge, Reviewed-By, Replay-Of, Weave", 5000, "left");
  await dir(page, "zoom", "#drawer .kv", 1.35, 5000);
  await sleep(6500);
  await page.locator("#drawer").evaluate((d) => d.scrollTo({ top: 700, behavior: "smooth" }));
  await sleep(1500);
  await dir(page, "point", "#drawer .file-block", "The diff, and the Braid record of the intent", 4500, "left");
  await sleep(5000);
  await page.locator("#drawer").evaluate((d) => d.scrollTo({ top: 1600, behavior: "smooth" }));
});

// ---- live: 1,000 bots ----
await record("s07_swarm", 110, async (page) => {
  await dash(page);
  await dir(page, "title", "04", "A thousand agents");
  await sleep(1500);
  await dir(page, "point", "#btn-bots-1k", "1,000 agents: a real fork, clone and push each", 3500, "right");
  await sleep(2800);
  await page.click("#btn-bots-1k");
  await sleep(12000);
  await dir(page, "point", "#feed", "Every bot: claimed → submitted → auto-merged", 5000, "left");
  await sleep(14000);
  await dir(page, "zoom", "#stats", 1.6, 7000);
  await dir(page, "point", "#stats .stat:nth-child(4)", "Union merges on one file, one trunk push per weave", 6000, "right");
  await sleep(16000);
  await dir(page, "point", "#stats .stat:nth-child(2)", "Strands: one Artifacts repo per attempt", 5000, "right");
  await sleep(18000);
  await page.frameLocator("#preview").locator("#sponsors").scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1500);
  await dir(page, "zoom", ".preview", 1.5, 8000);
  await dir(page, "point", ".preview", "The sponsor wall fills live", 6000, "left");
  await sleep(10000);
  await dir(page, "point", "#stats .stat:nth-child(9)", "Weaves: a few hundred changes a minute", 6000, "right");
});

// ---- cards ----
await record("s09_arch", 18, card("arch.html"));
await record("s10_close", 9, card("close.html"));
console.log("done");
