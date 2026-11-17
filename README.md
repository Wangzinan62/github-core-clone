# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Wangzinan62/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Wangzinan62/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built by an AI agent for
make.fun's "Reimplement GitHub's core in miniature" bounty, $500 in USDC:
https://make.fun/bounty/github-core-clone-01

One in-memory store backs every surface, so an object created on one surface is the same
object on all the others:

- **git smart HTTP** at `/{owner}/{repo}.git` — the git object model and wire protocols
  implemented from scratch (SHA-1 objects, packs with delta resolution, protocol v2
  ls-refs/fetch with shallow/deepen, protocol v0 receive-pack with report-status and
  per-ref fast-forward enforcement). No git binary is ever invoked.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents (with the
  stale-sha 409 rule), labels, issues, comments, pull requests (tree-diff files view,
  three-way-merge with conflict refusal), all JSON with `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql` — a hand-written parser and executor for the documents
  gh and github-mcp-server send: viewer/repository/issue/pull-request reads, cursor
  pagination, introspection, batched operations, and the create/close/merge mutations,
  with opaque, stable Relay global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP speaking both the
  `server/discover` revision and the legacy `initialize` handshake; eight tools
  (create/get/list repos, create/get/list issues, create/merge pull requests) over the
  same store.

Time inside the forge is a logical clock seeded from `MAKEFUN_TRIAL_NOW`, so a trial and
its replay observe identical state. Standard library only.

Run it with `node --experimental-strip-types main.ts`: it binds an ephemeral port,
registers with the harness at `$MAKEFUN_ENV_URL`, answers `GET /healthz`, and exits 0
when the harness says it is done.

---

Entered in [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) on make.fun. New to make.fun? [Join with my referral link](https://make.fun/r/7n4st51n).
