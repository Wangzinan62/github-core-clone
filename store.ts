// The forge's state and the operations every surface shares: repositories with their refs,
// the issues/pull-requests that share one number sequence per repository, labels, comments,
// and the commit machinery (contents writes and pull-request merges) that REST, GraphQL and
// MCP all funnel through so an object made on one surface is the same object on the others.
//
// Time is a logical clock seeded from MAKEFUN_TRIAL_NOW and advanced by a fixed step per
// mutation: nothing here reads the wall clock, so a trial and its replay agree byte for byte.

import {
  ObjectStore,
  buildCommit,
  commitHistory,
  diffMaps,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeMaps,
  parseCommit,
  parseTree,
  peelToCommit,
  unflattenTree,
  ZERO_OID,
} from './gitobj.ts';

/** The one login the trial's token names: the sealed suite's scenario viewer. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export function identityString(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

function trialNowSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // the scenario epoch, when the trial names no opening time
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  seq: number;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repository>();
  private repoIdCounter = 100000;
  private commentIdCounter = 0;
  private seqCounter = 0;
  private readonly epoch: number;
  private clockTick = 0;

  constructor() {
    this.epoch = trialNowSeconds();
  }

  /** The next logical timestamp, seconds: the trial's opening time plus one step per mutation. */
  now(): number {
    this.clockTick += 1;
    return this.epoch + this.clockTick;
  }

  /** The trial's opening time, seconds (the base every logical timestamp counts from). */
  get epochSeconds(): number {
    return this.epoch;
  }

  /** An ISO rendering of a logical timestamp, for the JSON surfaces. */
  iso(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  // ------------------------------------------------------------------ repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repository | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, init: { description?: string; isPrivate?: boolean }): Repository {
    this.repoIdCounter += 1;
    const repo: Repository = {
      id: this.repoIdCounter,
      owner: VIEWER.login,
      name,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  repoById(id: number): Repository | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  // ------------------------------------------------------------------ refs and commits

  /** Resolve a branch name, a full ref, a tag name or an oid to a commit oid (or null). */
  resolveCommit(repo: Repository, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = this.objects.get(ref);
      if (object === undefined) return null;
      return object.type === 'commit' ? ref : peelToCommit(this.objects, ref);
    }
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return peelToCommit(this.objects, oid);
    }
    return null;
  }

  branchTip(repo: Repository, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    return oid === undefined ? null : oid;
  }

  /** The tree oid of a commit. */
  treeOf(commitOid: string): string {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return '';
    return parseCommit(object.data).tree;
  }

  /** The tree oid of the directory at `path` inside a commit ('' when absent). */
  treeOidAt(commitOid: string, path: string): string {
    let tree = this.treeOf(commitOid);
    if (tree === '') return '';
    if (path === '') return tree;
    for (const part of path.split('/')) {
      const object = this.objects.get(tree);
      if (object === undefined || object.type !== 'tree') return '';
      const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (entry === undefined) return '';
      tree = entry.oid;
    }
    return tree;
  }

  /** The flattened file map of a commit's tree (empty for an unborn or unknown commit). */
  filesOf(commitOid: string | null): Map<string, { mode: string; oid: string }> {
    if (commitOid === null) return new Map();
    const tree = this.treeOf(commitOid);
    if (tree === '') return new Map();
    return flattenTree(this.objects, tree);
  }

  /**
   * Commit a new file map on a branch: one commit whose parent is the branch tip (or a root
   * commit when the branch is unborn). Answers the new commit oid.
   */
  commitFiles(repo: Repository, branch: string, files: Map<string, { mode: string; oid: string }>, message: string): string {
    const tree = unflattenTree(this.objects, files);
    const parent = this.branchTip(repo, branch);
    const ts = this.now();
    const identity = identityString();
    const commit = this.objects.put(
      'commit',
      buildCommit({
        tree,
        parents: parent === null ? [] : [parent],
        author: identity,
        committer: identity,
        timestamp: ts,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }

  /** Set one file's bytes on a branch (the contents write); answers the commit oid. */
  writeFile(repo: Repository, branch: string, path: string, content: Buffer, message: string): { commit: string; blob: string } {
    const tip = this.branchTip(repo, branch);
    const files = this.filesOf(tip);
    const blob = this.objects.put('blob', content);
    const existing = files.get(path);
    files.set(path, { mode: existing?.mode ?? '100644', oid: blob });
    const commit = this.commitFiles(repo, branch, files, message);
    return { commit, blob };
  }

  /** Remove one file from a branch; answers the commit oid. */
  deleteFile(repo: Repository, branch: string, path: string, message: string): string {
    const tip = this.branchTip(repo, branch);
    const files = this.filesOf(tip);
    files.delete(path);
    return this.commitFiles(repo, branch, files, message);
  }

  /** Commits reachable from a tip, children first (the commits listing). */
  history(tip: string): string[] {
    return commitHistory(this.objects, tip);
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repository, init: { title: string; body: string; labels: string[] }): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      number,
      title: init.title,
      body: init.body,
      state: 'open',
      labels: [...init.labels],
      seq: this.nextSeq(),
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(issue: Issue, body: string): IssueComment {
    this.commentIdCounter += 1;
    const comment: IssueComment = { id: this.commentIdCounter, body, seq: this.nextSeq() };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------------ pull requests

  createPull(
    repo: Repository,
    init: { title: string; body: string; headRef: string; baseRef: string },
  ): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, init.headRef);
    const baseSha = this.branchTip(repo, init.baseRef);
    if (headSha === null) return { error: `head branch ${init.headRef} does not exist` };
    if (baseSha === null) return { error: `base branch ${init.baseRef} does not exist` };
    if (init.headRef === init.baseRef) return { error: 'head and base are the same branch' };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === init.headRef && pull.baseRef === init.baseRef) {
        return { error: `a pull request from ${init.headRef} into ${init.baseRef} is already open` };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRequest = {
      number,
      title: init.title,
      body: init.body,
      state: 'open',
      headRef: init.headRef,
      baseRef: init.baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      seq: this.nextSeq(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The file changes a pull request carries right now (current base tip vs current head tip). */
  pullFiles(repo: Repository, pull: PullRequest): { path: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(this.objects, baseTip, headTip) ?? baseTip;
    const changes = diffMaps(this.objects, this.filesOf(base), this.filesOf(headTip));
    return changes.map((change) => ({ ...change, changes: change.additions + change.deletions }));
  }

  /** Whether the pull request's head merges cleanly into its base right now. */
  pullMergeable(repo: Repository, pull: PullRequest): boolean {
    if (pull.state !== 'open') return false;
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return false;
    if (isAncestor(this.objects, headTip, baseTip)) return true; // already up to date
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base === null) return false;
    const result = mergeMaps(this.filesOf(base), this.filesOf(baseTip), this.filesOf(headTip));
    return 'merged' in result;
  }

  /**
   * Merge a pull request into its base branch: 'merge' keeps both parents, 'squash' and
   * 'rebase' land one commit. Answers the merge commit oid, or a conflict marker.
   */
  mergePull(repo: Repository, pull: PullRequest, method: 'merge' | 'squash' | 'rebase'): { sha: string } | { conflict: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { error: 'a branch is missing' };
    if (isAncestor(this.objects, headTip, baseTip)) {
      // Nothing to merge: the head is already contained in the base.
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedSeq = this.nextSeq();
      pull.mergeCommitSha = baseTip;
      return { sha: baseTip };
    }
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base === null) return { error: 'no merge base' };
    const result = mergeMaps(this.filesOf(base), this.filesOf(baseTip), this.filesOf(headTip));
    if ('conflict' in result) return { conflict: result.conflict };
    const tree = unflattenTree(this.objects, result.merged);
    const ts = this.now();
    const identity = identityString();
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message =
      method === 'merge'
        ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
        : `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`;
    const commit = this.objects.put(
      'commit',
      buildCommit({ tree, parents, author: identity, committer: identity, timestamp: ts, message }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = this.nextSeq();
    pull.mergeCommitSha = commit;
    pull.baseSha = commit;
    return { sha: commit };
  }
}

export { ZERO_OID };
