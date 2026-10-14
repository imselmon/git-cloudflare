/**
 * Thin helpers over the Artifacts Workers binding: retries for repos that are
 * still forking, token minting, clone-free reads and a tree-level diff.
 */

export type RepoHandle = Awaited<ReturnType<Artifacts["get"]>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `get()` throws while a fork or import is still in progress; wait for it. */
export async function getRepo(ns: Artifacts, name: string, tries = 40): Promise<RepoHandle> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await ns.get(name);
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(250 * (i + 1), 2000));
    }
  }
  throw lastErr;
}

export async function mintToken(ns: Artifacts, repoName: string, scope: "read" | "write", ttlSeconds: number) {
  using repo = await getRepo(ns, repoName);
  return repo.createToken(scope, ttlSeconds);
}

export async function readFileAt(ns: Artifacts, repoName: string, ref: string, path: string): Promise<string | null> {
  using repo = await getRepo(ns, repoName);
  const blob = await repo.readFile({ ref, path });
  if (!blob) return null;
  return blob.text();
}

export async function readBlobAt(ns: Artifacts, repoName: string, ref: string, path: string): Promise<Blob | null> {
  using repo = await getRepo(ns, repoName);
  return repo.readFile({ ref, path });
}

export async function headOf(ns: Artifacts, repoName: string, ref = "main"): Promise<string | null> {
  using repo = await getRepo(ns, repoName);
  const entries = await repo.log({ ref, limit: 1 });
  const first = (entries as unknown as Array<Record<string, unknown>>)[0];
  if (!first) return null;
  return String(first.sha ?? first.oid ?? first.hash ?? first.id ?? "");
}

export type TreeChange = { path: string; kind: "added" | "modified" | "deleted"; baseHash: string | null; headHash: string | null };

/**
 * Merkle diff between two commits using only binding reads: subtrees with equal
 * hashes are skipped, so the cost scales with the size of the change, not the repo.
 */
export async function treeDiff(repo: RepoHandle, baseSha: string, headSha: string): Promise<TreeChange[]> {
  if (baseSha === headSha) return [];
  const [b, h] = await Promise.all([repo.readCommit(baseSha), repo.readCommit(headSha)]);
  if (!b || !h) throw new Error(`commit not found: ${!b ? baseSha : headSha}`);
  const out: TreeChange[] = [];
  await diffTrees(repo, b.treeHash, h.treeHash, "", out);
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}

async function diffTrees(repo: RepoHandle, baseTree: string | null, headTree: string | null, prefix: string, out: TreeChange[]) {
  if (baseTree === headTree) return;
  const [be, he] = await Promise.all([
    baseTree ? repo.readTree(baseTree) : Promise.resolve([] as ArtifactsTreeEntry[]),
    headTree ? repo.readTree(headTree) : Promise.resolve([] as ArtifactsTreeEntry[]),
  ]);
  const bmap = new Map((be ?? []).map((e) => [e.name, e]));
  const hmap = new Map((he ?? []).map((e) => [e.name, e]));
  const names = new Set([...bmap.keys(), ...hmap.keys()]);
  const pending: Promise<void>[] = [];
  for (const name of names) {
    const a = bmap.get(name), c = hmap.get(name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (a && c && a.hash === c.hash) continue;
    const aTree = a?.type === "tree", cTree = c?.type === "tree";
    if (aTree || cTree) {
      if (a && !aTree) out.push({ path, kind: "deleted", baseHash: a.hash, headHash: null });
      if (c && !cTree) out.push({ path, kind: "added", baseHash: null, headHash: c.hash });
      pending.push(diffTrees(repo, aTree ? a!.hash : null, cTree ? c!.hash : null, path, out));
      continue;
    }
    if (a && c) out.push({ path, kind: "modified", baseHash: a.hash, headHash: c.hash });
    else if (a) out.push({ path, kind: "deleted", baseHash: a.hash, headHash: null });
    else if (c) out.push({ path, kind: "added", baseHash: null, headHash: c.hash });
  }
  await Promise.all(pending);
}

export async function blobText(repo: RepoHandle, hash: string | null): Promise<string | null> {
  if (!hash) return null;
  const blob = await repo.readBlob(hash);
  return blob ? blob.text() : null;
}

/** Does `path` fall inside the declared scope? Scope entries are exact paths or directory prefixes ending in "/". Globs with a trailing "*" are allowed. */
export function inScope(path: string, scope: string[]): boolean {
  for (const s of scope) {
    if (s === path) return true;
    if (s.endsWith("/") && path.startsWith(s)) return true;
    if (s.endsWith("*") && path.startsWith(s.slice(0, -1))) return true;
  }
  return false;
}
