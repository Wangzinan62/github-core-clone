// GraphQL v4, the subset gh and github-mcp-server speak: a hand-written lexer/parser for
// operations, variables, inline fragments and input values, and a schema-driven executor
// over the forge store. Global ids are opaque base64 kind tags; unknown fields answer a 200
// with an errors array, as GitHub does; a JSON array body is operation batching.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER, type Issue, type PullRequest, type Repository } from './store.ts';
import { readBody } from './git.ts';

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          j += 2;
          if (esc === 'u') {
            value = value.slice(0, -1) + String.fromCharCode(parseInt(source.slice(j, j + 4), 16));
            j += 4;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const raw = source.slice(i, j);
      tokens.push({ kind: raw.includes('.') || /[eE]/.test(raw) ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().kind === 'name' ? (this.tokens[this.pos - 1] as { value: string }).value : null;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            if (this.peek().kind === 'punct' && this.peek().kind === 'punct') {
              // directives on variable definitions are not used by the suite
            }
          }
        }
        this.skipDirectives();
        operations.push({ operation: keyword, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        this.expectName();
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else if (keyword === 'subscription') {
        throw new Error('subscriptions are not supported');
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'eof') throw new Error('unterminated directive');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.skipPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args: { name: string; value: ValueNode }[] = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.skipPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        break;
    }
    throw new Error('unexpected value');
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- global ids

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function repoGid(repo: Repository): string {
  return gid('Repository', repo.id);
}

export function issueGid(repo: Repository, issue: Issue): string {
  return gid('Issue', repo.id, issue.number);
}

export function pullGid(repo: Repository, pull: PullRequest): string {
  return gid('PullRequest', repo.id, pull.number);
}

// --------------------------------------------------------------------------- value wrappers

interface GqlRepo {
  __typename: 'Repository';
  repo: Repository;
}
interface GqlIssue {
  __typename: 'Issue';
  repo: Repository;
  issue: Issue;
}
interface GqlPull {
  __typename: 'PullRequest';
  repo: Repository;
  pull: PullRequest;
}
interface GqlUser {
  __typename: 'User';
}
interface GqlRef {
  __typename: 'Ref';
  name: string;
}
interface GqlComment {
  __typename: 'IssueComment';
  id: string;
  body: string;
}
interface GqlConnection {
  __typename: string;
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
}

type GqlValue = GqlRepo | GqlIssue | GqlPull | GqlUser | GqlRef | GqlComment | GqlConnection | Record<string, unknown> | string | number | boolean | null;

class GqlError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

// --------------------------------------------------------------------------- connections

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match === null ? null : Number(match[1]);
}

interface PageArgs {
  first: number;
  after: unknown;
}

function pageArgs(args: Record<string, unknown>): PageArgs {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
  return { first, after: args.after ?? null };
}

/** Slice a seq-ordered list by a cursor page; answers the page and whether more remain. */
function pageBySeq<T extends { seq: number }>(items: T[], page: PageArgs, descending: boolean): { page: T[]; hasNext: boolean } {
  const afterSeq = seqOfCursor(page.after);
  const filtered = afterSeq === null ? items : items.filter((item) => (descending ? item.seq < afterSeq : item.seq > afterSeq));
  return { page: filtered.slice(0, page.first), hasNext: filtered.length > page.first };
}

function issuesConnection(ctx: Ctx, repo: Repository, args: Record<string, unknown>): GqlConnection {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
  const descending = orderBy !== null && orderBy.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const { page, hasNext } = pageBySeq(issues, pageArgs(args), descending);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue): GqlIssue => ({ __typename: 'Issue', repo, issue })),
    pageInfo: { hasNextPage: hasNext, endCursor: page.length === 0 ? null : cursorOf(page[page.length - 1]!.seq) },
    totalCount: issues.length,
  };
}

function pullsConnection(ctx: Ctx, repo: Repository, args: Record<string, unknown>): GqlConnection {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  if (states !== null) {
    pulls = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  pulls.sort((a, b) => a.seq - b.seq);
  const { page, hasNext } = pageBySeq(pulls, pageArgs(args), false);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull): GqlPull => ({ __typename: 'PullRequest', repo, pull })),
    pageInfo: { hasNextPage: hasNext, endCursor: page.length === 0 ? null : cursorOf(page[page.length - 1]!.seq) },
    totalCount: pulls.length,
  };
}

// --------------------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closed', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix', 'target'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlType {
  __typename: '__Type';
  name: string;
  kind: string;
  fields: { name: string }[] | null;
  enumValues: { name: string }[] | null;
}

function typeOf(name: string): GqlType | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: TYPE_FIELDS[name]!.map((field) => ({ name: field })), enumValues: null };
  }
  if (TYPE_ENUMS[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: TYPE_ENUMS[name]!.map((value) => ({ name: value })) };
  }
  if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) {
    return { __typename: '__Type', name, kind: 'SCALAR', fields: null, enumValues: null };
  }
  return null;
}

// --------------------------------------------------------------------------- field resolvers

type Resolver = (ctx: Ctx, source: never, args: Record<string, unknown>) => unknown;

function findRepoByGid(ctx: Ctx, id: unknown): Repository {
  const parsed = typeof id === 'string' ? parseGid(id) : null;
  if (parsed === null || parsed.kind !== 'Repository') throw new GqlError('repository id is not recognized');
  const repo = ctx.forge.repoById(Number(parsed.parts[0]));
  if (repo === undefined) throw new GqlError('repository not found');
  return repo;
}

const FIELDS: Record<string, Record<string, { type: string; list?: boolean; resolve: Resolver }>> = {
  Query: {
    viewer: { type: 'User', resolve: (): GqlUser => ({ __typename: 'User' }) },
    repository: {
      type: 'Repository',
      resolve: (ctx, _source, args) => {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = ctx.forge.getRepo(owner, name);
        return repo === undefined ? null : ({ __typename: 'Repository', repo } satisfies GqlRepo);
      },
    },
    node: {
      type: 'Node',
      resolve: (ctx, _source, args) => {
        const parsed = typeof args.id === 'string' ? parseGid(args.id) : null;
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = ctx.forge.repoById(Number(parsed.parts[0]));
          return repo === undefined ? null : ({ __typename: 'Repository', repo } satisfies GqlRepo);
        }
        if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
          const repo = ctx.forge.repoById(Number(parsed.parts[0]));
          if (repo === undefined) return null;
          const number = Number(parsed.parts[1]);
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } satisfies GqlIssue);
          }
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } satisfies GqlPull);
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_ctx, _source, args) => typeOf(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(ctx, input.repositoryId);
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') throw new GqlError('title is required');
        const issue = ctx.forge.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '', labels: [] });
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
        if (parsed === null || parsed.kind !== 'Issue') throw new GqlError('issue id is not recognized');
        const repo = ctx.forge.repoById(Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        if (repo === undefined || issue === undefined) throw new GqlError('issue not found');
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(ctx, input.repositoryId);
        const created = ctx.forge.createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          headRef: String(input.headRefName ?? ''),
          baseRef: String(input.baseRefName ?? ''),
        });
        if ('error' in created) throw new GqlError(created.error);
        return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: created } };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
        if (parsed === null || parsed.kind !== 'PullRequest') throw new GqlError('pull request id is not recognized');
        const repo = ctx.forge.repoById(Number(parsed.parts[0]));
        const pull = repo?.pulls.get(Number(parsed.parts[1]));
        if (repo === undefined || pull === undefined) throw new GqlError('pull request not found');
        const methodName = String(input.mergeMethod ?? 'MERGE');
        const method = methodName === 'SQUASH' ? 'squash' : methodName === 'REBASE' ? 'rebase' : 'merge';
        const result = ctx.forge.mergePull(repo, pull, method);
        if ('conflict' in result) throw new GqlError('Pull Request is not mergeable');
        if ('error' in result) throw new GqlError(result.error);
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
        if (parsed === null || parsed.kind !== 'Issue') throw new GqlError('subject id is not recognized');
        const repo = ctx.forge.repoById(Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        if (repo === undefined || issue === undefined) throw new GqlError('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = ctx.forge.addComment(issue, body);
        const node: GqlComment = { __typename: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body };
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
      },
    },
  },
  Repository: {
    id: { type: 'ID', resolve: (_ctx, source: GqlRepo) => repoGid(source.repo) },
    databaseId: { type: 'Int', resolve: (_ctx, source: GqlRepo) => source.repo.id },
    name: { type: 'String', resolve: (_ctx, source: GqlRepo) => source.repo.name },
    nameWithOwner: { type: 'String', resolve: (_ctx, source: GqlRepo) => `${source.repo.owner}/${source.repo.name}` },
    owner: { type: 'User', resolve: (): GqlUser => ({ __typename: 'User' }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (ctx, source: GqlRepo) => {
        const tip = ctx.forge.branchTip(source.repo, source.repo.defaultBranch);
        return tip === null ? null : ({ __typename: 'Ref', name: source.repo.defaultBranch } satisfies GqlRef);
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    description: { type: 'String', resolve: (_ctx, source: GqlRepo) => source.repo.description },
    isPrivate: { type: 'Boolean', resolve: (_ctx, source: GqlRepo) => source.repo.isPrivate },
    url: { type: 'String', resolve: (_ctx, source: GqlRepo) => `https://forge.invalid/${source.repo.owner}/${source.repo.name}` },
    issue: {
      type: 'Issue',
      resolve: (_ctx, source: GqlRepo, args) => {
        const issue = source.repo.issues.get(Number(args.number));
        return issue === undefined ? null : ({ __typename: 'Issue', repo: source.repo, issue } satisfies GqlIssue);
      },
    },
    issues: { type: 'IssueConnection', resolve: (ctx, source: GqlRepo, args) => issuesConnection(ctx, source.repo, args) },
    pullRequest: {
      type: 'PullRequest',
      resolve: (_ctx, source: GqlRepo, args) => {
        const pull = source.repo.pulls.get(Number(args.number));
        return pull === undefined ? null : ({ __typename: 'PullRequest', repo: source.repo, pull } satisfies GqlPull);
      },
    },
    pullRequests: { type: 'PullRequestConnection', resolve: (ctx, source: GqlRepo, args) => pullsConnection(ctx, source.repo, args) },
  },
  Issue: {
    id: { type: 'ID', resolve: (_ctx, source: GqlIssue) => issueGid(source.repo, source.issue) },
    number: { type: 'Int', resolve: (_ctx, source: GqlIssue) => source.issue.number },
    title: { type: 'String', resolve: (_ctx, source: GqlIssue) => source.issue.title },
    body: { type: 'String', resolve: (_ctx, source: GqlIssue) => source.issue.body },
    state: { type: 'String', resolve: (_ctx, source: GqlIssue) => (source.issue.state === 'open' ? 'OPEN' : 'CLOSED') },
    closed: { type: 'Boolean', resolve: (_ctx, source: GqlIssue) => source.issue.state === 'closed' },
    url: { type: 'String', resolve: (_ctx, source: GqlIssue) => `https://forge.invalid/${source.repo.owner}/${source.repo.name}/issues/${source.issue.number}` },
    author: { type: 'User', resolve: (): GqlUser => ({ __typename: 'User' }) },
    repository: { type: 'Repository', resolve: (_ctx, source: GqlIssue) => ({ __typename: 'Repository', repo: source.repo }) },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (_ctx, source: GqlPull) => pullGid(source.repo, source.pull) },
    number: { type: 'Int', resolve: (_ctx, source: GqlPull) => source.pull.number },
    title: { type: 'String', resolve: (_ctx, source: GqlPull) => source.pull.title },
    body: { type: 'String', resolve: (_ctx, source: GqlPull) => source.pull.body },
    state: {
      type: 'String',
      resolve: (_ctx, source: GqlPull) => (source.pull.merged ? 'MERGED' : source.pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    },
    merged: { type: 'Boolean', resolve: (_ctx, source: GqlPull) => source.pull.merged },
    headRefName: { type: 'String', resolve: (_ctx, source: GqlPull) => source.pull.headRef },
    baseRefName: { type: 'String', resolve: (_ctx, source: GqlPull) => source.pull.baseRef },
    mergeable: {
      type: 'String',
      resolve: (ctx, source: GqlPull) => {
        if (source.pull.state !== 'open') return 'UNKNOWN';
        return ctx.forge.pullMergeable(source.repo, source.pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (ctx, source: GqlPull, args) => {
        const changes = ctx.forge.pullFiles(source.repo, source.pull);
        const { first } = pageArgs(args);
        const nodes = changes.slice(0, first).map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
        }));
        return { __typename: 'PullRequestChangedFileConnection', nodes, pageInfo: { hasNextPage: changes.length > first, endCursor: null }, totalCount: changes.length } satisfies GqlConnection;
      },
    },
    author: { type: 'User', resolve: (): GqlUser => ({ __typename: 'User' }) },
    repository: { type: 'Repository', resolve: (_ctx, source: GqlPull) => ({ __typename: 'Repository', repo: source.repo }) },
  },
  User: {
    id: { type: 'ID', resolve: () => gid('User', VIEWER.id) },
    login: { type: 'String', resolve: () => VIEWER.login },
    name: { type: 'String', resolve: () => VIEWER.name },
    email: { type: 'String', resolve: () => VIEWER.email },
    url: { type: 'String', resolve: () => `https://forge.invalid/${VIEWER.login}` },
  },
  Ref: {
    name: { type: 'String', resolve: (_ctx, source: GqlRef) => source.name },
    prefix: { type: 'String', resolve: () => 'refs/heads/' },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (_ctx, source: GqlComment) => source.id },
    body: { type: 'String', resolve: (_ctx, source: GqlComment) => source.body },
    author: { type: 'User', resolve: (): GqlUser => ({ __typename: 'User' }) },
  },
  IssueConnection: {
    nodes: { type: 'Issue', list: true, resolve: (_ctx, source: GqlConnection) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source: GqlConnection) => ({ __typename: 'PageInfo', ...source.pageInfo }) },
    totalCount: { type: 'Int', resolve: (_ctx, source: GqlConnection) => source.totalCount },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest', list: true, resolve: (_ctx, source: GqlConnection) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source: GqlConnection) => ({ __typename: 'PageInfo', ...source.pageInfo }) },
    totalCount: { type: 'Int', resolve: (_ctx, source: GqlConnection) => source.totalCount },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile', list: true, resolve: (_ctx, source: GqlConnection) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source: GqlConnection) => ({ __typename: 'PageInfo', ...source.pageInfo }) },
    totalCount: { type: 'Int', resolve: (_ctx, source: GqlConnection) => source.totalCount },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (_ctx, source: Record<string, unknown>) => source.path },
    additions: { type: 'Int', resolve: (_ctx, source: Record<string, unknown>) => source.additions },
    deletions: { type: 'Int', resolve: (_ctx, source: Record<string, unknown>) => source.deletions },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (_ctx, source: Record<string, unknown>) => source.hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: () => false },
    startCursor: { type: 'String', resolve: (_ctx, source: Record<string, unknown>) => source.endCursor ?? null },
    endCursor: { type: 'String', resolve: (_ctx, source: Record<string, unknown>) => source.endCursor ?? null },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source: Record<string, unknown>) => source.issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source: Record<string, unknown>) => source.issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source: Record<string, unknown>) => source.pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source: Record<string, unknown>) => source.pullRequest },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (_ctx, source: Record<string, unknown>) => source.commentEdge },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (_ctx, source: Record<string, unknown>) => source.node },
  },
  __Type: {
    name: { type: 'String', resolve: (_ctx, source: GqlType) => source.name },
    kind: { type: 'String', resolve: (_ctx, source: GqlType) => source.kind },
    fields: { type: '__Field', list: true, resolve: (_ctx, source: GqlType) => source.fields },
    enumValues: { type: '__EnumValue', list: true, resolve: (_ctx, source: GqlType) => source.enumValues },
  },
  __Field: {
    name: { type: 'String', resolve: (_ctx, source: Record<string, unknown>) => source.name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (_ctx, source: Record<string, unknown>) => source.name },
  },
  Node: {
    id: {
      type: 'ID',
      resolve: (ctx, source: GqlValue) => {
        const value = source as GqlRepo | GqlIssue | GqlPull;
        if (value.__typename === 'Repository') return repoGid((value as GqlRepo).repo);
        if (value.__typename === 'Issue') return issueGid((value as GqlIssue).repo, (value as GqlIssue).issue);
        if (value.__typename === 'PullRequest') return pullGid((value as GqlPull).repo, (value as GqlPull).pull);
        void ctx;
        return null;
      },
    },
  },
};

// --------------------------------------------------------------------------- executor

function runtimeType(value: unknown, declared: string): string {
  if (typeof value === 'object' && value !== null && '__typename' in value) {
    return String((value as Record<string, unknown>).__typename);
  }
  return declared;
}

function executeSelections(ctx: Ctx, typeName: string, source: unknown, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === null || condition === typeName || condition === 'Node') {
        Object.assign(out, executeSelections(ctx, condition ?? typeName, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, typeName, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = FIELDS[typeName]?.[selection.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = (fieldDef.resolve as (c: Ctx, s: unknown, a: Record<string, unknown>) => unknown)(ctx, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'field failed' });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, fieldDef.type, fieldDef.list === true, value, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: Ctx, type: string, list: boolean, value: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (list) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeValue(ctx, type, false, item, selectionSet));
  }
  if (selectionSet === null || selectionSet.length === 0) return value;
  if (typeof value !== 'object') return value;
  const actual = runtimeType(value, type);
  return executeSelections(ctx, actual, value, selectionSet);
}

function executeOperation(forge: Forge, document: DocumentNode, operationName: string | null, variables: Record<string, unknown>): Record<string, unknown> {
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, defaultValue] of operation.variableDefaults) mergedVariables[name] = valueOf(defaultValue, {});
  Object.assign(mergedVariables, variables);
  const ctx: Ctx = { forge, variables: mergedVariables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, {}, operation.selectionSet);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// --------------------------------------------------------------------------- the HTTP handler

export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }));
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'operation must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    try {
      const document = new Parser(query).parseDocument();
      return executeOperation(forge, document, operationName, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
  };
  const body = Array.isArray(parsed) ? parsed.map(runOne) : runOne(parsed);
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
