/**
 * Three-way merging for Braid's weave step. Text files go through diff3;
 * JSON files get a structural union merge so many agents can touch the same
 * manifest without conflicting. A real conflict is never written: the caller
 * replays the change instead.
 */
import { merge as diff3 } from "node-diff3";

export type MergeKind = "clean" | "merged" | "union" | "same";
export type MergeResult = { ok: true; text: string; kind: MergeKind } | { ok: false; reason: string };

export function threeWay(path: string, base: string | null, trunk: string | null, strand: string | null): MergeResult {
  // Deletions: treat null as "absent".
  if (trunk === base) return { ok: true, text: strand ?? "", kind: "clean" };
  if (strand === base) return { ok: true, text: trunk ?? "", kind: "same" };
  if (trunk === strand) return { ok: true, text: trunk ?? "", kind: "same" };
  if (base === null || trunk === null || strand === null) {
    return { ok: false, reason: `${path}: added or deleted on both sides` };
  }
  if (path.endsWith(".json")) {
    const r = mergeJson(base, trunk, strand);
    if (r.ok) return { ok: true, text: r.text, kind: "union" };
    return { ok: false, reason: `${path}: ${r.reason}` };
  }
  const out = diff3(trunk, base, strand, { stringSeparator: "\n" });
  if (out.conflict) return { ok: false, reason: `${path}: overlapping edits` };
  let text = out.result.join("\n");
  if (strand.endsWith("\n") && !text.endsWith("\n")) text += "\n";
  return { ok: true, text, kind: "merged" };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function mergeJson(base: string, trunk: string, strand: string): { ok: true; text: string } | { ok: false; reason: string } {
  let b: Json, t: Json, s: Json;
  try {
    b = JSON.parse(base);
    t = JSON.parse(trunk);
    s = JSON.parse(strand);
  } catch {
    return { ok: false, reason: "invalid JSON on one side" };
  }
  const r = mergeValue(b, t, s, "$");
  if (!r.ok) return r;
  return { ok: true, text: JSON.stringify(r.value, null, 2) + "\n" };
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: Json): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

function mergeValue(b: Json, t: Json, s: Json, at: string): { ok: true; value: Json } | { ok: false; reason: string } {
  if (same(t, b)) return { ok: true, value: s };
  if (same(s, b)) return { ok: true, value: t };
  if (same(t, s)) return { ok: true, value: t };
  if (Array.isArray(b) && Array.isArray(t) && Array.isArray(s)) {
    // Union: keep trunk order, append strand additions, drop items either side removed.
    const key = (v: Json) => JSON.stringify(v);
    const bSet = new Set(b.map(key));
    const sSet = new Set(s.map(key));
    const tSet = new Set(t.map(key));
    const out: Json[] = [];
    const seen = new Set<string>();
    for (const v of t) {
      const k = key(v);
      if (bSet.has(k) && !sSet.has(k)) continue; // strand removed it
      if (!seen.has(k)) { out.push(v); seen.add(k); }
    }
    for (const v of s) {
      const k = key(v);
      if (bSet.has(k) && !tSet.has(k)) continue; // trunk removed it
      if (!seen.has(k)) { out.push(v); seen.add(k); }
    }
    return { ok: true, value: out };
  }
  if (isObj(b) && isObj(t) && isObj(s)) {
    const out: { [k: string]: Json } = {};
    const keys = new Set([...Object.keys(b), ...Object.keys(t), ...Object.keys(s)]);
    for (const k of keys) {
      const bv = k in b ? b[k] : null, tv = k in t ? t[k] : null, sv = k in s ? s[k] : null;
      const inB = k in b, inT = k in t, inS = k in s;
      if (!inT && inB && same(bv, sv)) continue; // trunk deleted, strand untouched
      if (!inS && inB && same(bv, tv)) continue; // strand deleted, trunk untouched
      const r = mergeValue(bv, tv, sv, `${at}.${k}`);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, reason: `both sides changed ${at}` };
}

/** A compact unified-ish diff for review prompts and the UI. */
export function simpleDiff(path: string, before: string | null, after: string | null, max = 4000): string {
  const a = (before ?? "").split("\n");
  const b = (after ?? "").split("\n");
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  // Longest-common-subsequence on lines (small files only).
  const n = a.length, m = b.length;
  if (n * m > 250_000) {
    out.push(`@@ ${n} -> ${m} lines (too large to diff) @@`);
    return out.join("\n");
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(" " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + a[i]); i++; }
    else { out.push("+" + b[j]); j++; }
  }
  while (i < n) out.push("-" + a[i++]);
  while (j < m) out.push("+" + b[j++]);
  const text = out.join("\n");
  return text.length > max ? text.slice(0, max) + "\n… (truncated)" : text;
}
