/** Workers AI prompts and a tolerant response reader for Braid's agents and reviewer. */
import type { Change } from "./types";

export const EDIT_MODEL = "@cf/zai-org/glm-5.3-flash";
export const REVIEW_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"; // fast, reliable JSON: reviews must not slow the weave
export const FAST_MODEL = REVIEW_MODEL;

type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function chat(env: Env, model: string, messages: Msg[], opts: { max_tokens?: number; temperature?: number; json?: boolean } = {}): Promise<string> {
  const input: Record<string, unknown> = { messages, max_tokens: opts.max_tokens ?? 3000, temperature: opts.temperature ?? 0.3 };
  if (opts.json) input.response_format = { type: "json_object" };
  let result: unknown;
  try {
    result = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, input);
  } catch (e) {
    // Some models reject response_format; retry without it.
    if (opts.json) {
      delete input.response_format;
      result = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, input);
    } else throw e;
  }
  return extractText(result);
}

export function extractText(r: unknown): string {
  if (typeof r === "string") return r;
  const o = r as Record<string, unknown>;
  if (!o) return "";
  if (typeof o.response === "string") return o.response;
  const choices = o.choices as Array<{ message?: { content?: string }; text?: string }> | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  if (choices?.[0]?.text) return choices[0].text as string;
  const output = o.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) for (const c of item.content ?? []) if (typeof c.text === "string" && c.type !== "reasoning") texts.push(c.text);
    if (texts.length) return texts.join("\n");
  }
  return JSON.stringify(r);
}

/** Pull the first JSON object out of a model reply, tolerating fences and prose. */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidates = [fenced?.[1], cleaned];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface EditResult {
  files: Record<string, string>;
  summary: string;
  rationale: string;
}

export function editMessages(change: Change, files: Record<string, string | null>, context: Record<string, string | null>, agent: string): Msg[] {
  const show = (m: Record<string, string | null>) =>
    Object.entries(m)
      .map(([p, c]) => `### ${p}\n${c === null ? "(does not exist yet)" : "```\n" + c + "\n```"}`)
      .join("\n\n");
  const system = `You are ${agent}, a coding agent working inside Braid, a version-control host for agent swarms.
You are editing a small static website (plain HTML fragments, CSS and JSON). Other agents edit other files at the same time, so:
- Only write files inside the declared scope. Never touch anything else.
- For sections/*.html write an HTML fragment (no <html>, <head> or <body>), starting with an <h2> unless it is the hero.
- When you add a section, also add its name to the "sections" array and a nav entry in site.json, keeping existing entries.
- Keep edits minimal and focused on the change. Do not rewrite unrelated lines.
- Write complete file contents, not diffs.
Reply with ONLY a JSON object: {"files": {"<path>": "<full new content>"}, "summary": "<one sentence>", "rationale": "<two sentences on how you met the acceptance note>"}.`;
  const user = `## Change: ${change.title}
${change.body}

Acceptance: ${change.accept}
Scope (the only files you may write): ${change.scope.join(", ")}
${change.hint ? `\nNote from the integrator about your previous attempt: ${change.hint}\n` : ""}
## Files in scope (current contents)
${show(files)}

## Read-only context
${show(context)}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface ReviewResult {
  conforms: boolean;
  risk: "low" | "medium" | "high";
  notes: string;
}

export function reviewMessages(change: Change, diff: string): Msg[] {
  return [
    {
      role: "system",
      content: `You are Braid's reviewer. You check that a diff does what its change says and nothing more. Be strict about scope creep and broken HTML/JSON, lenient about style. Reply with ONLY JSON: {"conforms": true|false, "risk": "low"|"medium"|"high", "notes": "<one or two sentences>"}.`,
    },
    {
      role: "user",
      content: `## Change: ${change.title}\n${change.body}\n\nAcceptance: ${change.accept}\nScope: ${change.scope.join(", ")}\n\n## Diff\n${diff}`,
    },
  ];
}
