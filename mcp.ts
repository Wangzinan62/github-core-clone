// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp. It speaks the modern
// server/discover revision and the legacy initialize handshake, and its tools act on the
// same store as REST and GraphQL, so an object made over MCP reads back over /api/v3 with
// the same ids. Stateless: no session header is issued, every request stands alone.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER, type Repository } from './store.ts';
import { issueJson, pullJson, repoJson } from './app.ts';
import { readBody } from './git.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string' };
const INTEGER = { type: 'integer' };
const BOOLEAN = { type: 'boolean' };

/** The tool list, built once: two tools/list calls must answer byte-identical bytes. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: schema({ name: STRING, description: STRING, private: BOOLEAN }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: schema({}, []),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: schema({ owner: STRING, repo: STRING, issue_number: INTEGER }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state (open, closed, all).',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: schema({ owner: STRING, repo: STRING, pull_number: INTEGER }, ['owner', 'repo', 'pull_number']),
  },
];

type RpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function resultResponse(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: RpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repository | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | RpcError {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { code: -32602, message: `Unknown tool: ${name}` };
  const required = (def.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(forge, repo));
    }
    case 'list_repos': {
      return toolResult(forge.listRepos().map((repo) => repoJson(forge, repo)));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const issue = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'get_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError('issue not found');
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return toolResult(issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const created = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: String(args.head),
        baseRef: String(args.base),
      });
      if ('error' in created) return toolError(created.error);
      return toolResult(pullJson(forge, repo, created));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      const result = forge.mergePull(repo, pull, 'squash');
      if ('conflict' in result) return toolError('Pull Request is not mergeable');
      if ('error' in result) return toolError(result.error);
      return toolResult(pullJson(forge, repo, pull));
    }
  }
  return { code: -32602, message: `Unknown tool: ${name}` };
}

function dispatch(forge: Forge, method: string, params: Record<string, unknown>): unknown | RpcError {
  switch (method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      return callTool(forge, name, args);
    }
    default:
      return { code: -32601, message: `Method not found: ${method}` };
  }
}

function isError(value: unknown): value is RpcError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value && !('content' in value);
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, authed: boolean): Promise<void> {
  const send = (status: number, value: unknown): void => {
    const text = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (!authed) {
    send(401, { message: 'Bad credentials' });
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    send(405, errorResponse(null, { code: -32600, message: 'Method not allowed' }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, errorResponse(null, { code: -32700, message: 'Parse error' }));
    return;
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    if (typeof entry !== 'object' || entry === null) return errorResponse(null, { code: -32600, message: 'Invalid request' });
    const record = entry as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : '';
    const id = (record.id ?? null) as RpcId;
    const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;
    if (record.id === undefined) return null; // a notification: no answer
    const outcome = dispatch(forge, method, params);
    return isError(outcome) ? errorResponse(id, outcome) : resultResponse(id, outcome);
  };
  if (Array.isArray(parsed)) {
    const answers = parsed.map(handleOne).filter((answer) => answer !== null);
    send(200, answers);
    return;
  }
  const answer = handleOne(parsed);
  if (answer === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  send(200, answer);
}
