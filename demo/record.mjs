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
const dash = async (page, hash = "") => { await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle" }); await page.waitForSelector("#changes .bd-row, #changes .empty"); await sleep(1500); };
const closeDrawer = async (page) => { await page.keyboard.press("Escape"); await sleep(400); };
const stateUntil = async (pred, maxMs) => { const t0 = Date.now(); for (;;) { const s = await api("/api/state"); if (pred(s)) return s; if (Date.now() - t0 > maxMs) return s; await sleep(2000); } };

// ---- cards ----
await record("s01_title", 18, card("title.html"));
await record("s02_ideas", 25, card("ideas.html"));

// ---- live: fresh project, eight agents ----
if (!only.size || only.has("s03_spawn")) { await api("/api/project/init", { force: true }); await sleep(4000); }
await record("s03_spawn", 92, async (page) => {
  await dash(page);
  await page.click("#btn-llm");
  await sleep(42000);
  const landed = page.locator("#changes .bd-row", { has: page.locator(".bd-badge[data-status=merged]") }).first();
  if (await landed.count()) { await landed.click(); await sleep(9000); await closeDrawer(page); }
  await sleep(10000);
  await page.frameLocator("#preview").locator("body").evaluate((b) => b.scrollTo({ top: 600, behavior: "smooth" })).catch(() => {});
});

// ---- live: staged conflict and replay ----
await record("s04_conflict", 170, async (page) => {
  await dash(page);
  await page.click("#btn-conflict");
  const t0 = Date.now();
  await stateUntil((s) => s.events.some((e) => e.kind === "replay" && Date.now() - e.ts < 200000), 130000);
  const row = page.locator("#changes .bd-row", { hasText: "Shorten the hero headline" }).first();
  if (await row.count()) { await row.click(); await sleep(8000); await closeDrawer(page); }
  await stateUntil((s) => s.changes.some((c) => c.title === "Shorten the hero headline" && c.status === "landed"), Math.max(10000, 160000 - (Date.now() - t0)));
  await sleep(5000);
});

// ---- card: MCP terminal ----
await record("s05_mcp", 30, card("terminal.html"));

// ---- live: revoke ----
if (!only.size || only.has("s06_revoke")) { await api("/api/swarm", { n: 2, kind: "llm", maxChanges: 1 }); await sleep(5000); }
await record("s06_revoke", 24, async (page) => {
  await dash(page);
  await page.click(".bd-tab[data-tab=agents]");
  await sleep(2500);
  const working = page.locator(".agent[data-status=working]").first();
  if (await working.count()) await working.click();
  await sleep(6000);
  await page.click(".bd-tab[data-tab=changes]");
  await page.click("#filter-seg button[data-filter=trouble]").catch(() => {});
});
await record("s06_term", 16, card("revoke.html"));

// ---- live: 1,000 bots ----
await record("s07_swarm", 110, async (page) => {
  await dash(page);
  await page.click("#btn-bots-1k");
  await sleep(70000);
  await page.frameLocator("#preview").locator("#sponsors").scrollIntoViewIfNeeded().catch(() => {});
});

// ---- live: code and commits ----
await record("s08_code", 42, async (page) => {
  await dash(page, "#code/main/");
  await sleep(2500);
  await page.locator("#tree .bd-row", { hasText: "sections" }).first().click();
  await sleep(2000);
  await page.locator("#tree .bd-row", { hasText: "hero.html" }).first().click();
  await sleep(3000);
  await page.click("#btn-why").catch(() => {});
  await sleep(5000);
  await page.click(".bd-tab[data-tab=trunk]");
  await sleep(3000);
  await page.locator("#log .bd-row").first().click();
  await sleep(5000);
  await page.locator("#drawer").evaluate((d) => d.scrollTo({ top: 700, behavior: "smooth" }));
  await sleep(5000);
  await page.locator("#drawer").evaluate((d) => d.scrollTo({ top: 1600, behavior: "smooth" }));
});

// ---- cards ----
await record("s09_arch", 18, card("arch.html"));
await record("s10_close", 9, card("close.html"));
console.log("done");
