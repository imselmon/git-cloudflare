// Narration with Cartesia Sonic. Reads CARTESIA_API_KEY from the environment or
// demo/.env, synthesises every segment in narration.json to out/audio/<key>.wav.
// Usage: node narrate.mjs            synthesise all segments
//        node narrate.mjs --voices   list English voices (name, id, description)
//        CARTESIA_VOICE_ID=<id> node narrate.mjs   use a specific voice
//        AUDIO_DIR=out/audio-<name> ...            write to another folder (keep several voices)
//        NARRATION=reel.json CARTESIA_LANGUAGE=hi ...   another script file, another language
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const ROOT = new URL("./", import.meta.url).pathname;
if (existsSync(`${ROOT}.env`)) {
  for (const line of readFileSync(`${ROOT}.env`, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.CARTESIA_API_KEY;
if (!KEY) { console.error("CARTESIA_API_KEY is not set (environment or demo/.env)"); process.exit(1); }
const API = "https://api.cartesia.ai";
const headers = { "X-API-Key": KEY, "Cartesia-Version": process.env.CARTESIA_VERSION ?? "2025-04-16", "Content-Type": "application/json" };

async function voices() {
  const out = [];
  let url = `${API}/voices/?limit=100`;
  for (let i = 0; i < 10 && url; i++) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`voices: ${r.status} ${await r.text()}`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.data ?? [];
    out.push(...list);
    url = !Array.isArray(j) && j.has_more && list.length ? `${API}/voices/?limit=100&starting_after=${list[list.length - 1].id}` : null;
  }
  return out;
}

if (process.argv.includes("--voices")) {
  const all = await voices();
  const en = all.filter((v) => !v.language || String(v.language).startsWith("en"));
  for (const v of en) console.log(`${v.id}  ${v.name}${v.gender ? ` (${v.gender})` : ""}  ${String(v.description ?? "").slice(0, 90)}`);
  console.log(`\n${en.length} English voices of ${all.length}`);
  process.exit(0);
}

const PREFERRED = (process.env.CARTESIA_VOICE_NAMES ?? "Brooke,Katie,Sophie,Jacqueline,Linda,Sarah,Nathan,Jordan,Blake").split(",").map((s) => s.trim().toLowerCase());
let voiceId = process.env.CARTESIA_VOICE_ID;
if (!voiceId) {
  const all = await voices();
  const en = all.filter((v) => !v.language || String(v.language).startsWith("en"));
  const pick = PREFERRED.map((n) => en.find((v) => String(v.name).toLowerCase() === n)).find(Boolean) ?? en[0];
  if (!pick) throw new Error("no English voice found");
  voiceId = pick.id;
  console.log(`voice: ${pick.name} (${pick.id})`);
}

const narrationFile = process.env.NARRATION ?? "narration.json";
const raw = JSON.parse(readFileSync(`${ROOT}${narrationFile}`, "utf8"));
// narration.json is {key: text}; reel.json is {segments: [{key, text}]}
const narration = Array.isArray(raw.segments) ? Object.fromEntries(raw.segments.map((x) => [x.key, x.text])) : raw;
const language = process.env.CARTESIA_LANGUAGE ?? "en";
const AUDIO = `${ROOT}${(process.env.AUDIO_DIR ?? "out/audio").replace(/\/$/, "")}/`;
mkdirSync(AUDIO, { recursive: true });
const models = (process.env.CARTESIA_MODEL ?? "sonic-3,sonic-2").split(",");
for (const [key, transcript] of Object.entries(narration)) {
  let ok = false, lastErr = "";
  for (const model_id of models) {
    const r = await fetch(`${API}/tts/bytes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model_id, transcript, voice: { mode: "id", id: voiceId }, output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 }, language }),
    });
    if (!r.ok) { lastErr = `${r.status} ${await r.text()}`; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(`${AUDIO}${key}.wav`, buf);
    console.log(`${key}: ${(buf.length / 1024).toFixed(0)} KB (${model_id})`);
    ok = true;
    break;
  }
  if (!ok) throw new Error(`${key}: ${lastErr}`);
}
console.log(`done: ${AUDIO}*.wav (build.mjs prefers .wav over .aiff; set AUDIO_DIR to match)`);
