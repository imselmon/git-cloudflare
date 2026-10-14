// Assembles demo/out/braid-demo.mp4 from the recorded scenes, the narration and
// burned-in captions. Needs ffmpeg/ffprobe and the recordings from record.mjs.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const ROOT = new URL("./", import.meta.url).pathname;
const OUT = `${ROOT}out/`;
mkdirSync(`${OUT}seg`, { recursive: true });
mkdirSync(`${OUT}cap`, { recursive: true });
const narration = JSON.parse(readFileSync(`${ROOT}narration.json`, "utf8"));
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

// scene: [name, source, speed, minSeconds, maxSeconds]
const SCENES = [
  ["s01_title", "s01_title", 1, 0, 0],
  ["s02_ideas", "s02_ideas", 1, 0, 0],
  ["s03_spawn", "s03_spawn", 1, 0, 92],
  ["s04_conflict", "s04_conflict", 2, 0, 80],
  ["s05_mcp", "s05_mcp", 1, 0, 30],
  ["s06_revoke", "s06_revoke", 1, 0, 24],
  ["s06_term", "s06_term", 1, 0, 16],
  ["s07_swarm", "s07_swarm", 2.2, 0, 55],
  ["s08_code", "s08_code", 1, 0, 42],
  ["s09_arch", "s09_arch", 1, 0, 0],
  ["s10_close", "s10_close", 1, 0, 0],
];
// Narration for the two-part revoke scene plays over the live part only; the terminal card is silent-but-captioned.
const AUDIO = { s06_revoke: "s06_revoke", s06_term: null };

function sentences(text) {
  return text.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 160 }, deviceScaleFactor: 1 });
await page.goto(`file://${ROOT}cards/caption.html`);
await page.waitForTimeout(300);
async function captionPng(text, file) {
  await page.evaluate((t) => { document.getElementById("cap").textContent = t; }, text);
  await page.waitForTimeout(40);
  await page.screenshot({ path: file, omitBackground: true });
}

const list = [];
const srt = [];
let clock = 0, idx = 1;
for (const [name, src, speed, minS, maxS] of SCENES) {
  const raw = `${OUT}raw/${src}.webm`;
  if (!existsSync(raw)) { console.warn(`missing ${raw}, skipping`); continue; }
  const audioKey = name in AUDIO ? AUDIO[name] : name;
  const aiff = audioKey ? `${OUT}audio/${audioKey}.aiff` : null;
  const nDur = aiff ? dur(aiff) : 0;
  let footage = dur(raw) / speed;
  let L = Math.max(nDur + 1.2, minS || 0, Math.min(footage, maxS || footage));
  if (!maxS && !minS) L = Math.max(nDur + 1.5, Math.min(footage, nDur + 3));
  L = Math.min(L, footage);
  const capText = audioKey ? narration[audioKey] : (name === "s06_term" ? "Revoked: the token is dead, so Artifacts refuses the push with a 403." : "");
  const caps = capText ? sentences(capText) : [];
  const totalChars = caps.reduce((a, c) => a + c.length, 0) || 1;
  const capSpan = nDur || L - 1;
  let t = 0.3;
  const overlays = [];
  for (let i = 0; i < caps.length; i++) {
    const d = (caps[i].length / totalChars) * capSpan;
    const file = `${OUT}cap/${name}_${i}.png`;
    await captionPng(caps[i], file);
    overlays.push({ file, a: t, b: Math.min(t + d, L - 0.2) });
    srt.push(`${idx++}\n${ts(clock + t)} --> ${ts(clock + Math.min(t + d, L - 0.2))}\n${caps[i]}\n`);
    t += d;
  }
  const inputs = ["-i", raw];
  for (const o of overlays) inputs.push("-i", o.file);
  if (aiff) inputs.push("-i", aiff);
  let chain = `[0:v]setpts=${(1 / speed).toFixed(4)}*PTS,fps=30,scale=1920:1080,format=yuv420p,fade=t=in:d=0.5,fade=t=out:st=${(L - 0.5).toFixed(2)}:d=0.5[v0]`;
  let last = "v0";
  overlays.forEach((o, i) => { chain += `;[${last}][${i + 1}:v]overlay=0:H-h:enable='between(t,${o.a.toFixed(2)},${o.b.toFixed(2)})'[v${i + 1}]`; last = `v${i + 1}`; });
  const aIdx = overlays.length + 1;
  chain += aiff ? `;[${aIdx}:a]aresample=48000,apad,atrim=0:${L.toFixed(2)},afade=t=out:st=${Math.max(0, L - 0.4).toFixed(2)}:d=0.4[a]` : `;anullsrc=r=48000:cl=stereo,atrim=0:${L.toFixed(2)}[a]`;
  const seg = `${OUT}seg/${name}.mp4`;
  ff([...inputs, "-filter_complex", chain, "-map", `[${last}]`, "-map", "[a]", "-t", L.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", seg]);
  console.log(`${name}: ${L.toFixed(1)}s (footage ${footage.toFixed(1)}s, voice ${nDur.toFixed(1)}s, ${caps.length} captions)`);
  list.push(`file '${seg}'`);
  clock += L;
}
await browser.close();
writeFileSync(`${OUT}list.txt`, list.join("\n") + "\n");
writeFileSync(`${OUT}braid-demo.srt`, srt.join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", `${OUT}list.txt`, "-c", "copy", `${OUT}braid-demo.mp4`]);
console.log(`\nbraid-demo.mp4: ${(clock / 60).toFixed(1)} min`);

function ts(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0").replace(".", ",")}`; }
