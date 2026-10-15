// Builds a 9:16 reel (1080x1920, 45 s) from reel.json: two full-frame cards,
// three cropped footage clips with Hinglish title plates, narration from
// out/audio-reel/<key>.wav (Cartesia) when present. Output: out/reel/braid-reel.mp4
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";

const ROOT = new URL("./", import.meta.url).pathname;
const OUT = `${ROOT}out/reel/`;
mkdirSync(`${OUT}raw`, { recursive: true });
mkdirSync(`${OUT}seg`, { recursive: true });
const AUDIO = `${ROOT}${(process.env.AUDIO_DIR ?? "out/audio-reel").replace(/\/$/, "")}/`;
const { segments } = JSON.parse(readFileSync(`${ROOT}reel.json`, "utf8"));
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const BG = "0x0a0e17";

const browser = await chromium.launch();

// 1. Full-frame cards, recorded so their CSS animations play.
for (const s of segments.filter((x) => x.kind === "card")) {
  const file = `${OUT}raw/${s.key}.webm`;
  if (existsSync(file) && !process.argv.includes("--rerecord")) continue;
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, recordVideo: { dir: `${OUT}raw`, size: { width: 1080, height: 1920 } } });
  const page = await ctx.newPage();
  await page.goto(`file://${ROOT}cards/${s.card}`);
  await page.waitForTimeout((s.seconds + 1) * 1000);
  const v = page.video();
  await ctx.close();
  renameSync(await v.path(), file);
  console.log(`${s.key}: card recorded`);
}

// 2. Title plates and the bottom banner.
const cap = await browser.newPage({ viewport: { width: 1080, height: 840 }, deviceScaleFactor: 1 });
await cap.goto(`file://${ROOT}cards/reel-caption.html`);
await cap.waitForTimeout(300);
for (const s of segments.filter((x) => x.kind === "footage")) {
  await cap.evaluate((t) => { document.getElementById("title").textContent = t; }, s.title);
  await cap.waitForTimeout(40);
  await cap.locator("#top").screenshot({ path: `${OUT}${s.key}-title.png`, omitBackground: true });
}
await cap.locator("#bottom").screenshot({ path: `${OUT}banner.png`, omitBackground: true });
await browser.close();

// 3. Segments.
const list = [];
let total = 0;
for (const s of segments) {
  const L = s.seconds;
  const wav = `${AUDIO}${s.key}.wav`;
  const hasAudio = existsSync(wav);
  if (hasAudio && dur(wav) > L - 0.2) console.warn(`${s.key}: narration ${dur(wav).toFixed(1)}s is longer than the ${L}s slot; it will be faded out`);
  const seg = `${OUT}seg/${s.key}.mp4`;
  const fades = `fade=t=in:d=0.4,fade=t=out:st=${(L - 0.4).toFixed(2)}:d=0.4`;
  const audio = hasAudio ? `[1:a]aresample=48000,apad,atrim=0:${L},afade=t=out:st=${Math.max(0, L - 0.5).toFixed(2)}:d=0.5[a]` : `anullsrc=r=48000:cl=stereo,atrim=0:${L}[a]`;
  if (s.kind === "card") {
    const inputs = ["-i", `${OUT}raw/${s.key}.webm`, ...(hasAudio ? ["-i", wav] : [])];
    ff([...inputs, "-filter_complex", `[0:v]fps=30,scale=1080:1920,format=yuv420p,${fades}[v];${audio}`, "-map", "[v]", "-map", "[a]", "-t", String(L), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", seg]);
  } else {
    const c = s.crop;
    const inputs = ["-ss", String(s.from), "-t", String(L + 0.5), "-i", `${ROOT}out/raw/${s.src}.webm`, "-i", `${OUT}${s.key}-title.png`, "-i", `${OUT}banner.png`, ...(hasAudio ? ["-i", wav] : [])];
    const aIn = hasAudio ? audio.replace("[1:a]", "[3:a]") : audio;
    const scaledH = Math.round((1080 * c.h) / c.w / 2) * 2; // keep the crop's aspect inside the 1080-wide band
    const padY = 480 + Math.floor((1080 - scaledH) / 2);
    const chain = `[0:v]fps=30,crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1080:${scaledH},pad=1080:1920:0:${padY}:color=${BG},format=yuv420p[f];[f][1:v]overlay=0:0[t];[t][2:v]overlay=0:1560,${fades}[v];${aIn}`;
    ff([...inputs, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-t", String(L), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", seg]);
  }
  console.log(`${s.key}: ${L}s${hasAudio ? "" : " (no narration yet)"}`);
  list.push(`file '${seg}'`);
  total += L;
}
writeFileSync(`${OUT}list.txt`, list.join("\n") + "\n");
ff(["-f", "concat", "-safe", "0", "-i", `${OUT}list.txt`, "-c", "copy", "-movflags", "+faststart", `${OUT}braid-reel.mp4`]);
console.log(`\nbraid-reel.mp4: ${total}s`);
