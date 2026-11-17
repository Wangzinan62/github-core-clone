// The HTTP surface: one server carrying the git smart-HTTP routes, the REST v3 API, the
// GraphQL endpoint and the MCP endpoint, all over the forge's one store. Every API reply is
// JSON with a request id; errors are JSON with a message; the token the harness minted for
// this process is the only credential, and the repositories live under its owner's login.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, type Issue, type PullRequest, type Repository } from './store.ts';
import { parseCommit } from './gitobj.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, readBody } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const FORGE_VERSION = '1.0.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function tokenOk(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true; // a local run without a harness
  return req.headers.authorization === `Bearer ${expected}`;
}

// --------------------------------------------------------------------------- JSON plumbing

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// --------------------------------------------------------------------------- serializers

export function repoJson(forge: Forge, repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    created_at: forge.iso(forge.epochSeconds + repo.seq),
    updated_at: forge.iso(forge.epochSeconds + repo.seq),
    size: 0,
  };
}

export function labelJson(forge: Forge, repo: Repository, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: repo.id * 10000 + [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? '000000',
    description: label?.description ?? '',
    default: false,
  };
}

export function issueJson(forge: Forge, repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(forge, repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: forge.iso(forge.epochSeconds + issue.seq),
    updated_at: forge.iso(forge.epochSeconds + issue.seq),
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.iso(forge.epochSeconds + comment.seq),
    updated_at: forge.iso(forge.epochSeconds + comment.seq),
  };
}

export function pullJson(forge: Forge, repo: Repository, pull: PullRequest): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.iso(forge.epochSeconds + pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.iso(forge.epochSeconds + pull.seq),
    updated_at: forge.iso(forge.epochSeconds + pull.seq),
  };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> {
  const object = forge.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid };
  const info = parseCommit(object.data);
  const person = (raw: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(raw);
    if (match === null) return { name: raw, email: '', date: forge.iso(forge.epochSeconds) };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: info.message.replace(/\n$/, ''),
      author: person(info.author),
      committer: person(info.committer),
      tree: { sha: info.tree },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// --------------------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate(req: IncomingMessage, url: URL, all: unknown[]): Page {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const linkFor = (target: number, rel: string): string => `<${base}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
  const links: string[] = [];
  if (page < lastPage) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (lastPage > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(lastPage, 'last'));
  }
  return { items, link: links.length === 0 ? null : links.join(', ') };
}

function sendPage(res: ServerResponse, page: Page): void {
  sendJson(res, 200, page.items, page.link === null ? {} : { link: page.link });
}

// --------------------------------------------------------------------------- the app

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', nextRequestId());
    route(forge, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  return server;
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    if (!tokenOk(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    await handleGraphQL(forge, req, res);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(forge, req, res, tokenOk(req));
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!tokenOk(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]!);
    const name = decodeURIComponent(gitMatch[2]!);
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    const leaf = gitMatch[3]!;
    if (leaf === 'info/refs') handleInfoRefs(forge, repo, req, res, url.searchParams.get('service'));
    else if (leaf === 'git-upload-pack') await handleUploadPack(forge, repo, req, res);
    else await handleReceivePack(forge, repo, req, res);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!tokenOk(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }
    await routeRest(forge, req, res, url);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- REST v3

async function routeRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments: ['api', 'v3', ...]
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, hooks: [], git: {}, pages: {}, importer: {} });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = str(body.value.name);
      if (name === undefined || name === '') return sendError(res, 422, 'name is required');
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return sendError(res, 422, 'name already exists on this account');
      }
      const repo = forge.createRepo(name, { description: str(body.value.description) ?? '', isPrivate: bool(body.value.private) ?? false });
      return sendJson(res, 201, repoJson(forge, repo));
    }
    if (method === 'GET') {
      return sendPage(res, paginate(req, url, forge.listRepos().map((repo) => repoJson(forge, repo))));
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const repo = forge.getRepo(owner, rest[2]!);
    if (repo === undefined) return sendError(res, 404, 'Not Found');
    await routeRepo(forge, req, res, url, repo, rest.slice(3));
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function routeRepo(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repository,
  parts: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const description = str(body.value.description);
      if (description !== undefined) repo.description = description;
      const name = str(body.value.name);
      if (name !== undefined && name !== '' && name !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = name;
        forge.repos.set(forge.repoKey(repo.owner, name), repo);
      }
      const isPrivate = bool(body.value.private);
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      const defaultBranch = str(body.value.default_branch);
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts[0] === 'git' && parts[1] === 'refs') {
    if (parts.length === 2 && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = str(body.value.ref);
      const sha = str(body.value.sha);
      if (ref === undefined || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return sendError(res, 422, 'ref and sha are required');
      if (!forge.objects.has(sha)) return sendError(res, 422, 'sha does not name an object');
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: forge.objects.get(sha)!.type } });
    }
    if (parts.length > 2 && method === 'GET') {
      const ref = `refs/${parts.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { ref, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } });
    }
    if (parts.length === 2 && method === 'GET') {
      const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } }));
      return sendJson(res, 200, list);
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts[0] === 'branches') {
    if (parts.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendPage(res, paginate(req, url, branches));
    }
    if (parts.length > 1 && method === 'GET') {
      const branch = parts.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts[0] === 'commits') {
    if (parts.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveCommit(repo, shaParam);
      if (tip === null) return sendJson(res, 200, []);
      const commits = forge.history(tip).map((oid) => commitJson(forge, oid));
      return sendPage(res, paginate(req, url, commits));
    }
    if (parts.length === 2 && method === 'GET') {
      const object = forge.objects.get(parts[1]!);
      if (object === undefined || object.type !== 'commit') return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, commitJson(forge, parts[1]!));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts[0] === 'contents') {
    await routeContents(forge, req, res, url, repo, parts.slice(1).join('/'));
    return;
  }

  if (parts[0] === 'labels') {
    await routeLabels(forge, req, res, repo, parts.slice(1));
    return;
  }

  if (parts[0] === 'issues') {
    await routeIssues(forge, req, res, url, repo, parts.slice(1));
    return;
  }

  if (parts[0] === 'pulls') {
    await routePulls(forge, req, res, url, repo, parts.slice(1));
    return;
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- contents

async function routeContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repository,
  path: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, ref);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const files = forge.filesOf(tip);
    const entry = files.get(path);
    if (entry !== undefined) {
      const blob = forge.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: entry.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    }
    // A directory: the entries directly under the path prefix.
    const prefix = path === '' ? '' : `${path}/`;
    const dirs = new Map<string, string>();
    const listing: Record<string, unknown>[] = [];
    const seenFiles = new Set<string>();
    for (const [filePath, fileEntry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (!seenFiles.has(rest)) {
          seenFiles.add(rest);
          listing.push({ type: 'file', name: rest, path: filePath, sha: fileEntry.oid, size: forge.objects.get(fileEntry.oid)?.data.length ?? 0 });
        }
      } else {
        const dirName = rest.slice(0, slash);
        if (!dirs.has(dirName)) dirs.set(dirName, forge.treeOidAt(tip, prefix + dirName));
      }
    }
    if (listing.length === 0 && dirs.size === 0 && path !== '') return sendError(res, 404, 'Not Found');
    for (const [dirName, sha] of dirs) listing.push({ type: 'dir', name: dirName, path: prefix + dirName, sha });
    listing.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    return sendJson(res, 200, listing);
  }

  if (method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const message = str(body.value.message);
    const contentB64 = str(body.value.content);
    if (message === undefined || contentB64 === undefined) return sendError(res, 422, 'message and content are required');
    const branch = str(body.value.branch) ?? repo.defaultBranch;
    if (forge.branchTip(repo, branch) === null && branch !== repo.defaultBranch) {
      // Creating a branch by writing to it: start from the default branch's tip. (An unborn
      // default branch is the normal first-commit case, handled by writeFile itself.)
      const base = forge.branchTip(repo, repo.defaultBranch);
      if (base === null) return sendError(res, 404, 'Not Found');
      repo.refs.set(`refs/heads/${branch}`, base);
    }
    const tip = forge.branchTip(repo, branch);
    const files = forge.filesOf(tip);
    const existing = files.get(path);
    const shaGiven = str(body.value.sha);
    if (existing !== undefined) {
      if (shaGiven === undefined) return sendError(res, 422, 'sha is required when updating a file');
      if (shaGiven !== existing.oid) return sendError(res, 409, 'the sha does not match the current file');
    }
    const data = Buffer.from(contentB64, 'base64');
    const written = forge.writeFile(repo, branch, path, data, message);
    const created = existing === undefined;
    return sendJson(res, created ? 201 : 200, {
      content: {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: written.blob,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      },
      commit: { sha: written.commit },
    });
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const message = str(body.value.message);
    const shaGiven = str(body.value.sha);
    if (message === undefined || shaGiven === undefined) return sendError(res, 422, 'message and sha are required');
    const branch = str(body.value.branch) ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    const files = forge.filesOf(tip);
    const existing = files.get(path);
    if (existing === undefined) return sendError(res, 404, 'Not Found');
    if (shaGiven !== existing.oid) return sendError(res, 409, 'the sha does not match the current file');
    const commit = forge.deleteFile(repo, branch, path, message);
    return sendJson(res, 200, { content: null, commit: { sha: commit } });
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- labels

async function routeLabels(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: Repository, parts: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (parts.length === 0) {
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(forge, repo, name)));
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = str(body.value.name);
      if (name === undefined || name === '') return sendError(res, 422, 'name is required');
      if (repo.labels.has(name)) return sendError(res, 422, 'a label with that name already exists');
      const color = (str(body.value.color) ?? '000000').replace(/^#/, '');
      repo.labels.set(name, { name, color, description: str(body.value.description) ?? '' });
      return sendJson(res, 201, labelJson(forge, repo, name));
    }
    return sendError(res, 404, 'Not Found');
  }
  const name = parts.join('/');
  if (!repo.labels.has(name)) return sendError(res, 404, 'Not Found');
  if (method === 'GET') return sendJson(res, 200, labelJson(forge, repo, name));
  if (method === 'PATCH') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const label = repo.labels.get(name)!;
    const newName = str(body.value.name);
    const color = str(body.value.color);
    if (color !== undefined) label.color = color.replace(/^#/, '');
    const description = str(body.value.description);
    if (description !== undefined) label.description = description;
    if (newName !== undefined && newName !== '' && newName !== name) {
      repo.labels.delete(name);
      label.name = newName;
      repo.labels.set(newName, label);
      for (const issue of repo.issues.values()) issue.labels = issue.labels.map((entry) => (entry === name ? newName : entry));
    }
    return sendJson(res, 200, labelJson(forge, repo, label.name));
  }
  if (method === 'DELETE') {
    repo.labels.delete(name);
    res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- issues

function labelNamesOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    } else return null;
  }
  return names;
}

async function routeIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repository,
  parts: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const labelsParam = url.searchParams.get('labels');
      const wantedLabels = labelsParam === null || labelsParam === '' ? [] : labelsParam.split(',').map((name) => name.trim());
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      if (wantedLabels.length > 0) issues = issues.filter((issue) => wantedLabels.every((name) => issue.labels.includes(name)));
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendPage(res, paginate(req, url, issues.map((issue) => issueJson(forge, repo, issue))));
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = str(body.value.title);
      if (title === undefined || title === '') return sendError(res, 422, 'title is required');
      const labels = labelNamesOf(body.value.labels);
      if (labels === null) return sendError(res, 422, 'labels must be an array of names');
      for (const name of labels) {
        if (!repo.labels.has(name)) return sendError(res, 422, `label ${name} does not exist`);
      }
      const issue = forge.createIssue(repo, { title, body: str(body.value.body) ?? '', labels });
      return sendJson(res, 201, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(parts[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (parts.length === 1) {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = str(body.value.title);
      if (title !== undefined) issue.title = title;
      const bodyText = str(body.value.body);
      if (bodyText !== undefined) issue.body = bodyText;
      const state = str(body.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const labels = labelNamesOf(body.value.labels);
      if (labels !== null && body.value.labels !== undefined) {
        for (const name of labels) if (!repo.labels.has(name)) return sendError(res, 422, `label ${name} does not exist`);
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts.length === 2 && parts[1] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') {
      return sendPage(res, paginate(req, url, issue.comments.map((comment) => commentJson(forge, comment))));
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const text = str(body.value.body);
      if (text === undefined) return sendError(res, 422, 'body is required');
      const comment = forge.addComment(issue, text);
      return sendJson(res, 201, commentJson(forge, comment));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts.length === 2 && parts[1] === 'labels' && method === 'POST') {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const labels = labelNamesOf(body.value.labels);
    if (labels === null) return sendError(res, 422, 'labels must be an array of names');
    for (const name of labels) if (!repo.labels.has(name)) return sendError(res, 422, `label ${name} does not exist`);
    for (const name of labels) if (!issue.labels.includes(name)) issue.labels.push(name);
    return sendJson(res, 200, issue.labels.map((name) => labelJson(forge, repo, name)));
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- pull requests

async function routePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repository,
  parts: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (parts.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      pulls.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendPage(res, paginate(req, url, pulls.map((pull) => pullJson(forge, repo, pull))));
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = str(body.value.title);
      const head = str(body.value.head);
      const base = str(body.value.base);
      if (title === undefined || head === undefined || base === undefined) return sendError(res, 422, 'title, head and base are required');
      const headRef = head.includes(':') ? head.split(':').pop()! : head;
      const created = forge.createPull(repo, { title, body: str(body.value.body) ?? '', headRef, baseRef: base });
      if ('error' in created) return sendError(res, 422, created.error);
      return sendJson(res, 201, pullJson(forge, repo, created));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(parts[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return sendError(res, 404, 'Not Found');

  if (parts.length === 1) {
    if (method === 'GET') return sendJson(res, 200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = str(body.value.title);
      if (title !== undefined) pull.title = title;
      const bodyText = str(body.value.body);
      if (bodyText !== undefined) pull.body = bodyText;
      const state = str(body.value.state);
      if (state === 'open' || state === 'closed') pull.state = state;
      const base = str(body.value.base);
      if (base !== undefined && forge.branchTip(repo, base) !== null) pull.baseRef = base;
      return sendJson(res, 200, pullJson(forge, repo, pull));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: forge.filesOf(forge.branchTip(repo, pull.headRef) ?? pull.headSha).get(change.path)?.oid ?? '',
    }));
    return sendPage(res, paginate(req, url, files));
  }

  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const methodName = str(body.value.merge_method) ?? 'merge';
    const mergeMethod = methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge';
    const result = forge.mergePull(repo, pull, mergeMethod);
    if ('conflict' in result) return sendError(res, 405, 'Pull Request is not mergeable');
    if ('error' in result) return sendError(res, 405, result.error);
    return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  sendError(res, 404, 'Not Found');
}
