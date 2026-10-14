/**
 * Git plumbing for Braid: clone, commit, push and notes against an Artifacts
 * remote, using isomorphic-git on an in-memory filesystem inside a Worker.
 */
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";

export type Author = { name: string; email: string };

/** Artifacts tokens look like `art_v1_<hex>?expires=<unix>`; Basic auth wants only the secret. */
export function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

function onAuth(token: string) {
  const password = tokenSecret(token);
  return () => ({ username: "braid", password });
}

export type Workspace = { fs: MemoryFS; dir: string };

/** Create a brand-new repo in memory, write files, commit and push `branch`. */
export async function initAndPush(opts: {
  remote: string;
  token: string;
  files: Record<string, string>;
  message: string;
  author: Author;
  branch?: string;
}): Promise<{ sha: string; ws: Workspace }> {
  const branch = opts.branch ?? "main";
  const fs = new MemoryFS();
  const dir = "/work";
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: branch });
  const sha = await commitFiles({ fs, dir }, opts.files, opts.message, opts.author);
  await push({ fs, dir }, { remote: opts.remote, token: opts.token, branch });
  return { sha, ws: { fs, dir } };
}

/** Shallow, single-branch clone into memory. */
export async function clone(opts: { remote: string; token: string; branch?: string; depth?: number }): Promise<Workspace> {
  const fs = new MemoryFS();
  const dir = "/work";
  await fs.mkdir(dir, { recursive: true });
  await git.clone({
    fs,
    http,
    dir,
    url: opts.remote,
    ref: opts.branch ?? "main",
    singleBranch: true,
    noTags: true,
    depth: opts.depth ?? 1,
    onAuth: onAuth(opts.token),
  });
  return { fs, dir };
}

/** Fetch one ref (for example refs/notes/braid) into the workspace so later commits on it fast-forward. Returns false if the remote lacks it. */
export async function fetchRef(ws: Workspace, opts: { remote: string; token: string; ref: string }): Promise<boolean> {
  try {
    await git.fetch({ fs: ws.fs, http, dir: ws.dir, url: opts.remote, ref: opts.ref, remoteRef: opts.ref, singleBranch: true, depth: 1, tags: false, onAuth: onAuth(opts.token) });
    const oid = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: opts.ref }).catch(() => null);
    if (!oid) {
      // fetch stored it under the remote-tracking name; pin the local ref to it
      const remoteOid = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: `refs/remotes/origin/${opts.ref.replace(/^refs\//, "")}` }).catch(() => null);
      if (!remoteOid) return false;
      await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: opts.ref, value: remoteOid, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** Write (or delete, when the value is null) files, stage them and commit. Returns the new sha. */
export async function commitFiles(
  ws: Workspace,
  files: Record<string, string | null>,
  message: string,
  author: Author,
): Promise<string> {
  const { fs, dir } = ws;
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      try {
        await fs.unlink(`${dir}/${path}`);
      } catch {
        /* already gone */
      }
      await git.remove({ fs, dir, filepath: path });
    } else {
      await fs.writeText(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
    }
  }
  return git.commit({ fs, dir, message, author: { ...author, timestamp: Math.floor(Date.now() / 1000) } });
}

export async function push(
  ws: Workspace,
  opts: { remote: string; token: string; branch?: string; force?: boolean; ref?: string; remoteRef?: string },
): Promise<void> {
  const ref = opts.ref ?? opts.branch ?? "main";
  const result = await git.push({
    fs: ws.fs,
    http,
    dir: ws.dir,
    url: opts.remote,
    ref,
    remoteRef: opts.remoteRef ?? ref,
    force: opts.force ?? false,
    onAuth: onAuth(opts.token),
  });
  if (!result.ok) throw new Error(`push failed: ${result.error ?? JSON.stringify(result.refs)}`);
  const refResult = result.refs?.[opts.remoteRef ?? ref];
  if (refResult && !refResult.ok) throw new Error(`push rejected: ${refResult.error}`);
}

export async function headSha(ws: Workspace, ref = "HEAD"): Promise<string> {
  return git.resolveRef({ fs: ws.fs, dir: ws.dir, ref });
}

/** Attach a note to a commit on refs/notes/<ns>. */
export async function addNote(ws: Workspace, oid: string, note: string, author: Author, ns = "intents"): Promise<void> {
  await git.addNote({ fs: ws.fs, dir: ws.dir, oid, note, author, ref: `refs/notes/${ns}`, force: true });
}

export async function readNote(ws: Workspace, oid: string, ns = "intents"): Promise<string | null> {
  try {
    const bytes = await git.readNote({ fs: ws.fs, dir: ws.dir, oid, ref: `refs/notes/${ns}` });
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export async function log(ws: Workspace, opts: { ref?: string; depth?: number } = {}) {
  return git.log({ fs: ws.fs, dir: ws.dir, ref: opts.ref ?? "HEAD", depth: opts.depth ?? 50 });
}

/** Parse "Key: value" trailers from the end of a commit message. */
export function parseTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = message.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}
