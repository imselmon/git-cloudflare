/**
 * MemoryFS: a small in-memory filesystem with the `fs.promises` surface that
 * isomorphic-git expects. Everything lives in a tree of Maps; paths are
 * POSIX-style and leading slashes are optional. Written for Braid.
 */

type FileNode = { kind: "file"; data: Uint8Array; mode: number; ino: number; mtime: number };
type DirNode = { kind: "dir"; children: Map<string, FsNode>; ino: number; mtime: number };
type LinkNode = { kind: "link"; target: string; ino: number; mtime: number };
type FsNode = FileNode | DirNode | LinkNode;

export class FsError extends Error {
  code: string;
  constructor(code: string, path: string) {
    super(`${code}: ${path}`);
    this.code = code;
    this.name = "FsError";
  }
}

export interface MemStat {
  type: string;
  mode: number;
  size: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  mtime: Date;
  ctime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

export class MemoryFS {
  private root: DirNode = { kind: "dir", children: new Map(), ino: 1, mtime: Date.now() };
  private nextIno = 2;

  /** isomorphic-git reads this property, so it must be an own enumerable field. */
  promises = {
    readFile: (p: string, o?: unknown) => this.readFile(p, o),
    writeFile: (p: string, d: string | Uint8Array, o?: unknown) => this.writeFile(p, d, o),
    unlink: (p: string) => this.unlink(p),
    readdir: (p: string) => this.readdir(p),
    mkdir: (p: string, o?: unknown) => this.mkdir(p, o),
    rmdir: (p: string) => this.rmdir(p),
    rm: (p: string, o?: { recursive?: boolean; force?: boolean }) => this.rm(p, o),
    stat: (p: string) => this.stat(p),
    lstat: (p: string) => this.lstat(p),
    readlink: (p: string) => this.readlink(p),
    symlink: (t: string, p: string) => this.symlink(t, p),
    chmod: (p: string, m: number) => this.chmod(p, m),
  };

  // ---- lookup helpers -------------------------------------------------

  private resolve(path: string): { parent: DirNode | null; name: string; node: FsNode | null } {
    const segs = segments(path);
    if (segs.length === 0) return { parent: null, name: "", node: this.root };
    let dir: DirNode = this.root;
    for (let i = 0; i < segs.length - 1; i++) {
      const next = dir.children.get(segs[i]);
      if (!next || next.kind !== "dir") return { parent: null, name: segs[segs.length - 1], node: null };
      dir = next;
    }
    const name = segs[segs.length - 1];
    return { parent: dir, name, node: dir.children.get(name) ?? null };
  }

  private mustGet(path: string): FsNode {
    const { node } = this.resolve(path);
    if (!node) throw new FsError("ENOENT", path);
    return node;
  }

  private statOf(node: FsNode): MemStat {
    const isFile = node.kind === "file";
    const isDir = node.kind === "dir";
    const isLink = node.kind === "link";
    const mode = isFile ? node.mode : isDir ? 0o40000 : 0o120000;
    const size = isFile ? node.data.byteLength : isLink ? node.target.length : 0;
    return {
      type: isFile ? "file" : isDir ? "dir" : "symlink",
      mode,
      size,
      ino: node.ino,
      dev: 0,
      uid: 0,
      gid: 0,
      mtimeMs: node.mtime,
      ctimeMs: node.mtime,
      mtime: new Date(node.mtime),
      ctime: new Date(node.mtime),
      isFile: () => isFile,
      isDirectory: () => isDir,
      isSymbolicLink: () => isLink,
    };
  }

  // ---- fs.promises surface ----------------------------------------------

  async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
    const node = this.mustGet(path);
    if (node.kind === "dir") throw new FsError("EISDIR", path);
    if (node.kind === "link") return this.readFile(node.target, options);
    const encoding = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
    return encoding ? dec.decode(node.data) : node.data;
  }

  async writeFile(path: string, data: string | Uint8Array, options?: unknown): Promise<void> {
    const { parent, name, node } = this.resolve(path);
    if (!parent) throw new FsError("ENOENT", path);
    if (node && node.kind === "dir") throw new FsError("EISDIR", path);
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const optMode = typeof options === "object" && options ? (options as { mode?: number }).mode : undefined;
    const mode = optMode ?? (node && node.kind === "file" ? node.mode : 0o100644);
    parent.children.set(name, { kind: "file", data: bytes, mode, ino: this.nextIno++, mtime: Date.now() });
    parent.mtime = Date.now();
  }

  async unlink(path: string): Promise<void> {
    const { parent, name, node } = this.resolve(path);
    if (!parent || !node) throw new FsError("ENOENT", path);
    if (node.kind === "dir") throw new FsError("EISDIR", path);
    parent.children.delete(name);
  }

  async readdir(path: string): Promise<string[]> {
    const node = this.mustGet(path);
    if (node.kind !== "dir") throw new FsError("ENOTDIR", path);
    return [...node.children.keys()].sort();
  }

  async mkdir(path: string, options?: unknown): Promise<void> {
    const recursive = typeof options === "object" && options ? Boolean((options as { recursive?: boolean }).recursive) : false;
    if (recursive) {
      let dir = this.root;
      for (const seg of segments(path)) {
        let next = dir.children.get(seg);
        if (!next) {
          next = { kind: "dir", children: new Map(), ino: this.nextIno++, mtime: Date.now() };
          dir.children.set(seg, next);
        }
        if (next.kind !== "dir") throw new FsError("ENOTDIR", path);
        dir = next;
      }
      return;
    }
    const { parent, name, node } = this.resolve(path);
    if (!parent) throw new FsError("ENOENT", path);
    if (node) throw new FsError("EEXIST", path);
    parent.children.set(name, { kind: "dir", children: new Map(), ino: this.nextIno++, mtime: Date.now() });
  }

  async rmdir(path: string): Promise<void> {
    const { parent, name, node } = this.resolve(path);
    if (!parent || !node) throw new FsError("ENOENT", path);
    if (node.kind !== "dir") throw new FsError("ENOTDIR", path);
    if (node.children.size > 0) throw new FsError("ENOTEMPTY", path);
    parent.children.delete(name);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const { parent, name, node } = this.resolve(path);
    if (!node) {
      if (options?.force) return;
      throw new FsError("ENOENT", path);
    }
    if (node.kind === "dir" && node.children.size > 0 && !options?.recursive) throw new FsError("ENOTEMPTY", path);
    parent?.children.delete(name);
  }

  async stat(path: string): Promise<MemStat> {
    const node = this.mustGet(path);
    if (node.kind === "link") return this.stat(node.target);
    return this.statOf(node);
  }

  async lstat(path: string): Promise<MemStat> {
    return this.statOf(this.mustGet(path));
  }

  async readlink(path: string): Promise<string> {
    const node = this.mustGet(path);
    if (node.kind !== "link") throw new FsError("EINVAL", path);
    return node.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const { parent, name, node } = this.resolve(path);
    if (!parent) throw new FsError("ENOENT", path);
    if (node) throw new FsError("EEXIST", path);
    parent.children.set(name, { kind: "link", target, ino: this.nextIno++, mtime: Date.now() });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.mustGet(path);
    if (node.kind === "file") node.mode = mode;
  }

  // ---- Braid conveniences -----------------------------------------------

  /** All file paths under `dir`, relative to it, skipping `.git`. */
  walk(dir = "/"): string[] {
    const out: string[] = [];
    const visit = (node: DirNode, prefix: string) => {
      for (const [name, child] of node.children) {
        if (name === ".git") continue;
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.kind === "dir") visit(child, p);
        else out.push(p);
      }
    };
    const start = this.mustGet(dir);
    if (start.kind !== "dir") throw new FsError("ENOTDIR", dir);
    visit(start, "");
    return out.sort();
  }

  async readText(path: string): Promise<string | null> {
    try {
      return (await this.readFile(path, "utf8")) as string;
    } catch (e) {
      if ((e as FsError).code === "ENOENT") return null;
      throw e;
    }
  }

  /** Write a text file, creating parent directories. */
  async writeText(path: string, text: string): Promise<void> {
    const segs = segments(path);
    if (segs.length > 1) await this.mkdir(segs.slice(0, -1).join("/"), { recursive: true });
    await this.writeFile(path, text);
  }
}
