// The git object model, implemented from scratch on node:crypto/node:zlib: SHA-1 addressed
// blobs, trees, commits and annotated tags in one content-addressed store, pack read/write
// (plain objects out; plain and delta objects in), tree flatten/diff/three-way-merge, and the
// reachability walks the wire protocol and the REST surface share.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<string, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const ID_TYPES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The one object store: every repository's objects live here, addressed by their SHA-1. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (blob) under a tree, keyed by its slash-joined path. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, base: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Inverse of flattenTree: store the nested trees for a path->blob map and answer the root tree oid. */
export function unflattenTree(store: ObjectStore, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i]!, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, timestamp: match === null ? 0 : Number(match[1]), message };
}

export function buildCommit(info: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const stamp = (identity: string): string => {
    const bare = identity.replace(/ \d+ [+-]\d{4}$/, '');
    return `${bare} ${info.timestamp} +0000`;
  };
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${stamp(info.author)}`);
  lines.push(`committer ${stamp(info.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message: split === -1 ? '' : text.slice(split + 2) };
}

/** Follow tag objects to the commit they name; a commit answers itself, anything else null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// --------------------------------------------------------------------------- history walks

/** Ancestor commits of a tip, children before parents (a stack DFS in first-parent order). */
export function commitHistory(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return order;
}

export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
  return new Set(commitHistory(store, tip));
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestorSet(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(store, a);
  for (const candidate of commitHistory(store, b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

// --------------------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** Added/removed line counts between two blob bodies (an LCS diff, with a size cap). */
function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: countLines(after), deletions: countLines(before) };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const saved = dp[j]!;
      dp[j] = a[i] === b[j] ? diagonal + 1 : Math.max(dp[j]!, dp[j + 1]!);
      diagonal = saved;
    }
  }
  const common = dp[0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changes between two flattened trees, in path order. */
export function diffMaps(
  store: ObjectStore,
  before: Map<string, { mode: string; oid: string }>,
  after: Map<string, { mode: string; oid: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry === undefined) {
      const blob = store.get(oldEntry.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob === undefined ? 0 : countLines(blob.data) });
    } else if (oldEntry === undefined && newEntry !== undefined) {
      const blob = store.get(newEntry.oid);
      changes.push({ path, status: 'added', additions: blob === undefined ? 0 : countLines(blob.data), deletions: 0 });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldBlob = store.get(oldEntry.oid);
      const newBlob = store.get(newEntry.oid);
      const counts = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      changes.push({ path, status: 'modified', ...counts });
    }
  }
  return changes;
}

/**
 * A three-way merge of flattened trees. Both sides changed the same path differently (or one
 * deleted what the other changed) is a conflict; everything else resolves to the changed side.
 */
export function mergeMaps(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }> } | { conflict: string } {
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      const entry = ours.get(path) ?? theirs.get(path);
      if (entry !== undefined) merged.set(path, entry);
    } else if (b === o) {
      const entry = theirs.get(path);
      if (entry !== undefined) merged.set(path, entry);
    } else if (b === t) {
      const entry = ours.get(path);
      if (entry !== undefined) merged.set(path, entry);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}

// --------------------------------------------------------------------------- reachability for fetch

/** Every object reachable from a set of oids (commits with their history, trees, blobs, tags). */
export function objectClosure(store: ObjectStore, roots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree, ...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * Every object reachable from a set of oids, except that commits named in `cut` do not pass
 * the walk to their parents (a shallow clone holds the boundary commit and its trees, but
 * none of its history). This is the set a fetch may treat as "the client already holds it".
 */
export function objectClosureCut(store: ObjectStore, roots: Iterable<string>, cut: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      if (!cut.has(oid)) stack.push(...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

export interface FetchSelection {
  /** The objects to pack. */
  objects: string[];
  /** Commits at the depth boundary (the shallow lines), when a depth was requested. */
  boundary: string[];
}

/**
 * What a fetch sends: the objects reachable from the wants, less everything the client
 * already holds (the haves' closure, cut at the shallow boundary), with commit traversal
 * cut at `depth` generations when a depth is given. Tag objects naming a wanted commit ride
 * along; boundary commits are reported for shallow-info.
 */
export function selectFetchObjects(store: ObjectStore, wants: string[], haves: string[], shallow: string[], depth: number | null): FetchSelection {
  const excluded = objectClosureCut(store, haves, new Set(shallow));
  const includedCommits = new Map<string, number>();
  const extraRoots: string[] = [];
  const queue: { oid: string; distance: number }[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') queue.push({ oid: want, distance: 1 });
    else if (object.type === 'tag') {
      extraRoots.push(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ oid: commit, distance: 1 });
    } else {
      extraRoots.push(want);
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    const known = includedCommits.get(oid);
    if (known !== undefined && known <= distance) continue;
    includedCommits.set(oid, distance);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth !== null && distance >= depth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, distance: distance + 1 });
  }
  const objects = new Set<string>();
  for (const oid of extraRoots) if (!excluded.has(oid)) objects.add(oid);
  for (const oid of includedCommits.keys()) {
    if (excluded.has(oid)) continue;
    objects.add(oid);
    const commit = store.get(oid);
    if (commit === undefined) continue;
    for (const inner of objectClosure(store, [parseCommit(commit.data).tree])) {
      if (!excluded.has(inner)) objects.add(inner);
    }
  }
  return { objects: [...objects], boundary: [...boundary].filter((oid) => !excluded.has(oid)) };
}

// --------------------------------------------------------------------------- packs

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (ID_TYPES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of the named objects, whole (no deltas), with its SHA-1 trailer. */
export function buildPack(store: ObjectStore, oids: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(oids.length, 4);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the one zlib stream starting at `offset`; answers the data and the bytes it
 * consumed. Synchronous (inflateSync with info): pack ingest runs inside request handlers
 * where a thread-pool round trip per object would dominate the push workload.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

function readPackHeader(buffer: Buffer, offset: number): { type: number; size: number; next: number } {
  let byte = buffer[offset]!;
  const type = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  let cursor = offset + 1;
  while (byte & 0x80) {
    byte = buffer[cursor]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    cursor += 1;
  }
  return { type, size, next: cursor };
}

/** Apply a git delta (copy/insert instructions) to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readVarint(); // the base size, not needed beyond the format
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset]!;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  void produced;
  return out;
}

/**
 * Read a whole pack into the store (objects a delta names as its base may already be in the
 * store). Answers the number of objects stored; throws on a malformed pack or a bad trailer.
 */
export function ingestPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  let offset = 12;
  const pending: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  const local = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const objectStart = offset;
    const header = readPackHeader(pack, offset);
    offset = header.next;
    let baseOid: string | null = null;
    if (header.type === 6) {
      // OFS-delta: a negative offset from this object's start names the base.
      let byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOid = byOffset.get(objectStart - back) ?? null;
    } else if (header.type === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset);
    offset += consumed;
    if (header.type === 6 || header.type === 7) {
      const base = (baseOid !== null ? local.get(baseOid) : undefined) ?? (baseOid !== null ? store.get(baseOid) : undefined);
      if (base === undefined || baseOid === null) throw new Error('delta base is missing');
      const merged = applyDelta(base.data, data);
      const oid = hashObject(base.type, merged);
      local.set(oid, { type: base.type, data: merged });
      byOffset.set(objectStart, oid);
      pending.push({ oid, type: base.type, data: merged });
    } else {
      const type = TYPE_IDS[header.type];
      if (type === undefined) throw new Error(`unknown pack object type ${header.type}`);
      const oid = hashObject(type, data);
      local.set(oid, { type, data });
      byOffset.set(objectStart, oid);
      pending.push({ oid, type, data });
    }
  }
  for (const entry of pending) {
    if (!store.objects.has(entry.oid)) store.objects.set(entry.oid, { type: entry.type, data: entry.data });
  }
  return pending.length;
}
