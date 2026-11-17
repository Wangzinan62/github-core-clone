// Entry point for the forge.
//
// The harness that grades this program talks to it through one environment
// variable, MAKEFUN_ENV_URL, which points at the harness's own HTTP origin.
// The lifecycle is deliberately small:
//
//   1. Build the application server with createApp() and bind it to an
//      ephemeral port (port 0). Port 8080 belongs to the harness and must
//      never be bound here.
//   2. Tell the harness where we landed: POST {env}/register {"port": N}.
//   3. Poll GET {env}/done until it answers {"done": true}, then shut the
//      server down and exit 0.
//
// Both harness calls are retried forever on transient trouble (network
// errors, unexpected statuses) with an exponential backoff, because the
// harness may still be starting when this process boots. The only fatal
// outcomes are a missing MAKEFUN_ENV_URL and a register call answered with
// 400 or 405, which mean the request itself violates the contract.

import { createApp } from './app.ts';

/** Milliseconds a single register/done request may run before we abandon it. */
const REQUEST_TIMEOUT_MS = 30_000;

/** First pause between two attempts of the same call, in milliseconds. */
const BACKOFF_START_MS = 250;

/** Longest pause between two attempts, in milliseconds. */
const BACKOFF_LIMIT_MS = 2_000;

/** The harness origin with trailing slashes removed, or '' when unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build one retry-delay sequence: the first call waits BACKOFF_START_MS,
 * each later call waits twice as long, never more than BACKOFF_LIMIT_MS.
 * Each retried operation gets its own sequence, starting fresh.
 */
function makeBackoff(): () => Promise<void> {
  let wait = BACKOFF_START_MS;
  return async () => {
    await pause(wait);
    wait = Math.min(wait * 2, BACKOFF_LIMIT_MS);
  };
}

/**
 * POST our bound port to the harness until it accepts the registration.
 * 200 means registered; 409 means another process registered first, which
 * is fine — we simply carry on to the done poll either way.
 */
async function registerPort(origin: string, port: number): Promise<void> {
  const backoff = makeBackoff();
  for (;;) {
    let status = 0;
    let body = '';
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      body = await response.text();
    } catch {
      status = 0; // network error or timeout: fall through to the retry
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`register rejected with HTTP ${status}: ${body}`);
    }
    await backoff();
  }
}

/** Poll the harness's /done endpoint until it reports the run is over. */
async function awaitDone(origin: string): Promise<void> {
  const backoff = makeBackoff();
  for (;;) {
    let finished = false;
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      finished = false; // any failure simply means "not done yet"
    }
    if (finished) return;
    await backoff();
  }
}

async function run(origin: string): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  console.log(`forge listening on port ${address.port}`);

  await registerPort(origin, address.port);
  console.log('registered with the harness; waiting for done');

  await awaitDone(origin);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('harness reported done; shutting down');
}

const origin = envOrigin();
if (origin === '') {
  console.error('MAKEFUN_ENV_URL is not set; there is no harness to register with');
  process.exit(1);
}

run(origin).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
