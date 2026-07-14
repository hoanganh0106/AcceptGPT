# CDK Session Invite Web App Design

## Overview

The feature stays inside the existing AcceptGPT Node.js process. Fastify serves
the public redemption page, the administrator page, and every API route. A
server-only Supabase client stores settings and CDK history in Postgres. The
browser never connects to Supabase.

One redemption has two unrelated credential domains:

1. `SUPABASE_SECRET_KEY` is a long-lived backend credential loaded once from the
   protected VPS environment. It is never available to route output or browser
   JavaScript.
2. The submitted ChatGPT session is request-local data. Only
   `RedemptionService` and `ChatGptJoinClient` may hold it, and only while the
   redemption is active.

The irreversible boundary is the successful `consume_cdk` RPC. Before that
boundary, an error leaves the CDK `unused`. After it, status remains `used`
regardless of invite, Playwright, network, client, process, or result-write
failure. The separate `result` column records what happened without controlling
reuse.

The feature deliberately does not manage Playwright's workspace. Candidate-side
ChatGPT calls use the snapshotted `invite_workspace_id`; the existing
Playwright page accepts the resulting email in whichever workspace the operator
has opened. The admin page makes this operational responsibility explicit.

## Chosen Approach and Alternatives

### Chosen: Fastify -> Supabase Data API/RPC

Fastify creates `@supabase/supabase-js` with `SUPABASE_URL` and the new
`SUPABASE_SECRET_KEY`. Ordinary server-side reads/writes use the Data API, and
the one-time claim uses a Postgres function through `rpc()`. This follows the
requested deployment model, keeps credentials off the browser, and places the
race-sensitive transition in Postgres.

### Rejected: direct Postgres connection

A direct connection and `UPDATE ... RETURNING` transaction could provide the
same atomic claim. It adds connection-string management and pool lifecycle to a
small single-process service, and it does not follow the requested Supabase RPC
contract.

### Rejected: browser Supabase client

RLS plus a publishable key could expose limited user operations, but this
feature has no Supabase end-user identity and all administrator operations use
elevated authority. A browser client would expand the attack surface and
conflict with the explicit Fastify-only boundary.

### Rejected: SQLite

SQLite could make one-process consumption atomic, but it would keep state on one
VPS and require local file backup/recovery. The selected Supabase design gives
managed Postgres persistence while retaining a single Fastify application.

## Runtime Baseline and Dependencies

- Node.js 24 LTS, TypeScript 5, Fastify 4, Playwright, Caddy, and systemd.
- Add `@supabase/supabase-js` as a production dependency and lock the installed
  version in `package-lock.json`.
- Keep Fastify-4-compatible `@fastify/cookie@9` and
  `@fastify/rate-limit@9` for admin sessions and route throttling.
- Keep `tsx` plus Node's built-in test runner; do not add another test framework.
- Do not add `better-sqlite3`, a Postgres connection pool, a browser Supabase
  SDK bundle, or native database build prerequisites.

The active task upgrades deployment from the older Node.js 20 bootstrap to
Node.js 24. The repository has no existing CDK/SQLite implementation or data,
so this is a design replacement rather than a data migration.

## Configuration Contract

`src/config.ts` exposes deterministic `parseConfig(env)` and cached
`loadConfig()` functions. New fields are:

```ts
export interface AppConfig {
  publicOrigin: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  adminPassword: string;
  adminSessionSecret: string;
  cdkHashSecret: string;
  adminSessionTtlMs: number;
  redeemRateLimitMax: number;
  loginRateLimitMax: number;
  rateLimitWindowMs: number;
  maxQueueDepth: number;
  chatGptBaseUrl: string;
  chatGptRequestTimeoutMs: number;
  joinMaxRetries: number;
  joinRetryBackoffMs: number;
}
```

`SUPABASE_URL` must be an HTTPS Supabase project URL. Production
`SUPABASE_SECRET_KEY` must begin with `sb_secret_`; configuration does not accept
the legacy service-role JWT variable as an alias. `CDK_HASH_SECRET` and
`ADMIN_SESSION_SECRET` are independent secrets of at least 32 characters.
Rotating the Supabase key must not invalidate CDKs; rotating
`CDK_HASH_SECRET` does.

`toServerConfig(config)` returns a narrow projection for `buildServer` that
omits `supabaseSecretKey`, `cdkHashSecret`, and `adminPassword`. It includes the
independent cookie-signing secret because Fastify's cookie plugin needs it. The
full `AppConfig` is retained only in the composition root long enough to
construct the client/services that own the omitted values.

```ts
export interface ServerConfig {
  host: string;
  port: number;
  webhookPath: string;
  webhookSecret: string | null;
  publicOrigin: string;
  adminSessionSecret: string;
  redeemRateLimitMax: number;
  loginRateLimitMax: number;
  rateLimitWindowMs: number;
}
```

`.env.example` contains names and obviously fake placeholders only. Production
values exist only in the protected VPS `.env` used by systemd.

## Component Boundaries

### `src/supabase-types.ts`

Owns the narrow generated/manual TypeScript database contract for
`app_settings`, `cdks`, and `consume_cdk`. No browser module imports it.

```ts
export type CdkStatus = 'unused' | 'used';

export type CdkResult =
  | 'processing'
  | 'accepted'
  | 'already_member'
  | 'join_rejected'
  | 'accept_not_found'
  | 'worker_unavailable'
  | 'upstream_timeout'
  | 'internal_error'
  | 'service_interrupted';
```

Database timestamps cross the API boundary as ISO strings. UUIDs cross as
strings and are validated at Fastify input boundaries.

### `src/supabase-client.ts`

Owns server-only client construction. It never exports the URL or key and never
logs configuration.

```ts
export type AppSupabaseClient = SupabaseClient<Database>;

export function createSupabaseClient(config: Pick<AppConfig,
  'supabaseUrl' | 'supabaseSecretKey'
>): AppSupabaseClient;
```

Construction disables browser-oriented auth persistence:

```ts
createClient<Database>(config.supabaseUrl, config.supabaseSecretKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
```

The client is injected into the store. Page renderers, route response objects,
and logger metadata never receive it.

### `src/cdk.ts`

Owns normalization, display formatting, cryptographically secure generation,
and HMAC hashing. It has no Supabase dependency.

```ts
export interface GeneratedCdk {
  plaintext: string;
  codeHash: string;
}

export const CDK_PATTERN = /^[A-HJ-NP-Z2-9]{16}$/;
export function normalizeCdk(input: string): string;
export function formatCdk(normalized: string): string;
export function hashCdk(normalized: string, secret: string): string;
export function generateCdk(secret: string): GeneratedCdk;
```

The alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` excludes `0`, `1`, `I`, and
`O`. Sixteen base-32 characters provide 80 random bits. HMAC-SHA-256 uses only
`CDK_HASH_SECRET`. Plaintext never crosses into `SupabaseCdkStore`.

### `src/supabase-store.ts`

Owns all Supabase queries, row decoding, safe error classification, and the RPC
call. It is asynchronous and contains no Fastify, session, ChatGPT, Playwright,
or HTML logic.

```ts
export interface ClaimedCdk {
  id: string;
  email: string;
  workspaceId: string;
  usedAt: string;
  result: 'processing';
}

export interface CdkHistoryRecord {
  id: string;
  status: CdkStatus;
  email: string | null;
  workspaceId: string | null;
  result: CdkResult | null;
  createdAt: string;
  usedAt: string | null;
}

export interface CdkHistoryPage {
  records: CdkHistoryRecord[];
  total: number;
}

export interface CdkStore {
  getInviteWorkspaceId(): Promise<string | null>;
  setInviteWorkspaceId(workspaceId: string): Promise<void>;
  hasUnusedCdk(codeHash: string): Promise<boolean>;
  insertCdkHashes(codeHashes: string[]): Promise<void>;
  claimCdk(input: {
    codeHash: string;
    email: string;
    workspaceId: string;
  }): Promise<ClaimedCdk | null>;
  finishCdk(id: string, result: Exclude<CdkResult, 'processing'>): Promise<boolean>;
  markInterrupted(): Promise<number>;
  listCdkHistory(limit: number, offset: number): Promise<CdkHistoryPage>;
}
```

`hasUnusedCdk` is an optimization only. `claimCdk` calls
`supabase.rpc('consume_cdk', ...)` and treats an empty result as
`CDK_INVALID_OR_USED`. `finishCdk` updates only `status='used' AND
result='processing'`, so terminal results are write-once. It retries only
clearly transient Data API failures; it never resets status.

`insertCdkHashes` inserts one complete batch in one Data API statement. A unique
hash collision fails the whole statement; the caller generates a new complete
batch. Plaintext is returned only after insertion succeeds.

The store maps Supabase failures to stable internal codes. It logs only the
operation name, HTTP status, Postgres error code, and safe row ID when available;
it never logs request payloads, response bodies, keys, hashes, or emails from
failed low-level calls.

### `src/session-input.ts`

Owns parsing exactly one submitted session, decoding claims, and best-effort
credential clearing. It excludes export/conversion features from `gptk12.txt`.

```ts
export interface SessionCredentials {
  accessToken: string;
  clear(): void;
}

export interface SessionClaims {
  email: string;
  accountId: string;
  expiresAt: number;
}

export function parseSingleSession(input: unknown): SessionCredentials;
export function decodeSessionClaims(accessToken: string, now?: number): SessionClaims;
```

JWT decoding is a shape/expiry check, not cryptographic validation. Remote
validation belongs to `ChatGptJoinClient` and must complete before `claimCdk`.

### `src/chatgpt-join-client.ts`

Owns cookie-less server-side requests to `https://chatgpt.com`. It receives
`fetch`, sleep, and UUID providers for tests and never logs authorization
headers or raw bodies.

```ts
export type MembershipState = 'member' | 'not-member' | 'unknown';

export interface ValidatedSession {
  email: string;
  accountId: string;
}

export interface JoinAttempt {
  membership: MembershipState;
  requestAccepted: boolean;
  inviteAccepted: boolean;
}

export interface JoinClient {
  validateSession(
    credentials: SessionCredentials,
    claims: SessionClaims,
  ): Promise<ValidatedSession>;
  requestJoin(
    credentials: SessionCredentials,
    workspaceId: string,
  ): Promise<JoinAttempt>;
  verifyMembership(
    credentials: SessionCredentials,
    workspaceId: string,
  ): Promise<MembershipState>;
}
```

The adapter preserves the required userscript order: request, supplementary
accept, then structural membership checks. It retries only network/timeouts,
`429`, and `5xx`; it maps other responses to allowlisted safe codes.

### `src/queue.ts` and `src/worker.ts`

The existing RAM FIFO remains the sole serialization point for Playwright. The
minimal extension adds source and optional completion, but no workspace field.

```ts
export type JobSource = 'webhook' | 'redemption';

export type JobCompletion =
  | { kind: 'processed'; results: EmailResult[]; count: number | null }
  | { kind: 'session-expired' }
  | { kind: 'error'; code: 'automation-error' | 'worker-stopped' };

export interface Job {
  id: string;
  emails: string[];
  receivedAt: number;
  source: JobSource;
  complete?: (result: JobCompletion) => void;
}

export interface AwaitableJob {
  job: Job;
  completion: Promise<JobCompletion>;
}

export function createWebhookJob(emails: string[]): Job;
export function createAwaitableJob(emails: string[]): AwaitableJob;
```

The worker may continue coalescing all adjacent email jobs because workspace is
operator-managed and intentionally absent from the contract. It invokes the
unchanged `WorkspacePage.runAcceptFlow(page, emails)`, then projects results
back to every original job. Only webhook-source results feed the existing JSON
history and normal Telegram result/error summaries; redemption results are
stored in `cdks.result`. A Playwright session-expired event retains the existing
operator notification and resolves all waiting redemption jobs.

`JobQueue` gains a capacity limit and `close()` so shutdown settles queued
waiters. No job may contain session material, a CDK value/hash, a Supabase
credential, or a workspace ID.

### `src/redemption-service.ts`

Owns the business flow and is the only application service allowed to retain
`SessionCredentials` across awaits.

```ts
export type RedemptionResult =
  | { ok: true; status: 'accepted' | 'already_member'; email: string }
  | { ok: false; code: RedemptionErrorCode; message: string };

export class RedemptionService {
  redeem(input: { cdk: unknown; session: unknown }): Promise<RedemptionResult>;
}
```

The exact sequence is:

1. Read and validate the current `invite_workspace_id`; retain it as this
   request's snapshot.
2. Normalize and HMAC the CDK. Optionally reject a hash that is not currently
   unused, while treating this read as non-authoritative.
3. Parse one session, decode claims, and remotely validate token/email.
4. Call `claimCdk({ codeHash, email, workspaceId })`. Only a returned row crosses
   the irreversible boundary; an empty return loses the race.
5. Use the same workspace snapshot for candidate request/accept/membership
   calls.
6. If membership is confirmed, finish with `already_member` or `accepted`.
7. Otherwise enqueue only the email, await its exact Playwright result, and map
   it to `accepted` or `accept_not_found`.
8. Replace `processing` with one safe terminal result. If this write fails, the
   row remains `used/processing`; return a safe persistence error and allow
   startup recovery to mark it `service_interrupted`.
9. In `finally`, clear credentials and remove local references.

All pre-claim errors leave the row unchanged. All post-claim exceptions map to
a safe terminal result when Supabase is reachable, but terminal recording is
never allowed to control reuse. A disconnected Fastify client does not cancel
the already-claimed operation.

### `src/admin-auth.ts`

Owns password comparison, bounded ephemeral sessions, expiry, signed cookies,
and session-bound CSRF tokens. Restart signs administrators out.

```ts
export interface AdminSession {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export class AdminAuth {
  static create(options: AdminAuthOptions): Promise<AdminAuth>;
  login(password: unknown): Promise<AdminSession | null>;
  authenticate(signedCookie: string | undefined): AdminSession | null;
  assertMutation(
    session: AdminSession,
    csrf: unknown,
    origin: string | undefined,
  ): void;
  logout(sessionId: string): void;
}
```

The cookie remains `__Host-acceptgpt_admin`, `Secure`, `HttpOnly`,
`SameSite=Strict`, signed, and scoped to `/`. Authentication grants access only
to setting update, CDK creation, and history.

### `src/web-pages.ts` and `src/server.ts`

`web-pages.ts` renders dependency-free HTML with escaped text and per-response
CSP nonces. Browser scripts use only relative Fastify URLs. No page receives the
Supabase client, URL, key, CDK hash, or earlier plaintext codes.

`server.ts` is the dependency-injected route boundary:

```ts
export interface ServerDependencies {
  queue: JobQueue;
  worker: Worker;
  redemptions: RedemptionService;
  cdkStore: CdkStore;
  cdkIssuer: CdkIssuer;
  adminAuth: AdminAuth;
}

export function buildServer(
  config: ServerConfig,
  logger: Logger,
  dependencies: ServerDependencies,
): FastifyInstance;
```

Routes are:

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/` | Public | Redemption page |
| `POST` | `/api/redeem` | CDK | Await final redemption result |
| `GET` | `/admin` | Public/cookie | Login/dashboard shell |
| `POST` | `/api/admin/login` | Password | Create admin session |
| `POST` | `/api/admin/logout` | Cookie + CSRF | Destroy admin session |
| `GET` | `/api/admin/state` | Cookie | Setting and paged CDK history |
| `PUT` | `/api/admin/workspace` | Cookie + CSRF | Update Invite Workspace ID |
| `POST` | `/api/admin/cdks` | Cookie + CSRF | Create 1-100 codes, return once |
| `GET` | `/health` | Public | Existing health plus worker/store readiness |
| `POST` | configured webhook | Existing secret | Existing async webhook behavior |

There is no revoke/delete/reactivate endpoint. The admin page shows the exact
warning “Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK.” next
to both the setting and generation controls.

## PostgreSQL Schema and Functions

The versioned migration lives under `supabase/migrations/`. The logical schema
is:

```sql
create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  invite_workspace_id uuid,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, invite_workspace_id)
values (1, null)
on conflict (id) do nothing;

create table public.cdks (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'unused'
    check (status in ('unused', 'used')),
  email text,
  used_at timestamptz,
  result text check (result in (
    'processing', 'accepted', 'already_member', 'join_rejected',
    'accept_not_found', 'worker_unavailable', 'upstream_timeout',
    'internal_error', 'service_interrupted'
  )),
  workspace_id uuid,
  created_at timestamptz not null default now(),
  check (
    (status = 'unused' and email is null and used_at is null
      and result is null and workspace_id is null)
    or
    (status = 'used' and email is not null and used_at is not null
      and result is not null and workspace_id is not null)
  )
);

create index cdks_created_at_idx on public.cdks (created_at desc);
create index cdks_status_created_at_idx
  on public.cdks (status, created_at desc);
```

The consume function is one conditional statement:

```sql
create or replace function public.consume_cdk(
  p_code_hash text,
  p_email text,
  p_workspace_id uuid
)
returns table (
  id uuid,
  email text,
  workspace_id uuid,
  used_at timestamptz,
  result text
)
language sql
security invoker
set search_path = ''
as $$
  update public.cdks
  set status = 'used',
      email = lower(btrim(p_email)),
      used_at = now(),
      result = 'processing',
      workspace_id = p_workspace_id
  where code_hash = p_code_hash
    and status = 'unused'
  returning cdks.id, cdks.email, cdks.workspace_id,
            cdks.used_at, cdks.result;
$$;
```

PostgreSQL row locking makes concurrent conditional updates atomic. Exactly one
caller can update an `unused` row; later callers receive no returned row.

A `BEFORE UPDATE` trigger enforces these invariants independently of Node:

- `code_hash` never changes;
- `used` never changes back to `unused`;
- email, `used_at`, and workspace snapshot cannot change after use;
- `result` may change only from `processing` to one terminal value;
- a terminal result cannot be overwritten.

The migration enables RLS on both tables and creates no `anon` or
`authenticated` policy. It revokes all table/function privileges from
`public`, `anon`, and `authenticated`; resets the two tables' `service_role`
privileges before granting only required select/insert/column-update privileges
and execution of the consume/trigger functions to the backend role; and does
not grant application-level delete or truncate. It revokes function execution
from browser roles. The consume function remains `SECURITY INVOKER`, so it does
not create an additional privilege-escalation boundary.

## Data Flows

### Redemption

```text
Browser
  -> Fastify POST /api/redeem
  -> RedemptionService
       -> SupabaseCdkStore: read invite_workspace_id snapshot
       -> CDK module: normalize + HMAC
       -> SupabaseCdkStore: optional unused lookup
       -> Session parser: one session, claims, expiry
       -> ChatGPT client: remote token/email validation
       -> Supabase RPC: unused -> used + email/time/result/workspace
       -> ChatGPT client: request + supplementary accept + verify
       -> if needed: RAM queue(email only) -> existing Playwright flow
       -> SupabaseCdkStore: processing -> terminal result
       -> finally: clear session references
  <- sanitized final JSON
```

### Administration

```text
Admin browser
  -> Fastify cookie + CSRF + exact Origin
  -> validated admin route
  -> SupabaseCdkStore
       -> singleton setting update, or
       -> hash-only batch insert, or
       -> history projection without code_hash
  <- sanitized no-store JSON
```

The browser never bypasses Fastify in either flow.

## Error and Result Model

Public errors have stable codes and Vietnamese messages. Raw `Error.message`,
ChatGPT bodies, and Supabase bodies are never returned.

| Public code | HTTP | Claim occurred? | Stored result when claimed |
|---|---:|---:|---|
| `INVALID_INPUT` | 400 | No | N/A |
| `CDK_INVALID_OR_USED` | 400 | No for this call | N/A |
| `SESSION_INVALID` | 422 | No | N/A |
| `WORKSPACE_NOT_CONFIGURED` | 503 | No | N/A |
| `SUPABASE_UNAVAILABLE` | 503 | Unknown/No | `processing` if commit won |
| `JOIN_REJECTED` | 422 | Yes | `join_rejected` |
| `ACCEPT_NOT_FOUND` | 422 | Yes | `accept_not_found` |
| `WORKER_UNAVAILABLE` | 503 | Yes | `worker_unavailable` |
| `UPSTREAM_TIMEOUT` | 504 | Depends on boundary | `upstream_timeout` if claimed |
| `INTERNAL_ERROR` | 500 | Depends on boundary | `internal_error` if claimed |
| `ADMIN_SESSION_EXPIRED` | 401 | N/A | N/A |
| `CSRF_REJECTED` | 403 | N/A | N/A |

An HTTP failure around a remote RPC can be ambiguous: Postgres may have
committed before the response was lost. The safe rule is never to assume the
code is still unused. The backend returns a safe unavailable/used message and
performs no invite side effect; if Postgres committed, the row remains
`used/processing` and startup recovery later marks it `service_interrupted`.
Operators resolve ambiguity from history; the application never refunds the
code.

## Security Model

- Caddy terminates TLS. Fastify binds to `127.0.0.1` and trusts proxy headers
  only from loopback.
- The secret key is appropriate only for the backend and bypasses RLS; route
  authentication and authorization are mandatory before every admin store call.
- No publishable/anon key is needed by this application.
- Redemption and login have independent in-memory per-IP rate limits. Suggested
  defaults are 10 redemptions per 10 minutes and 5 login attempts per 15
  minutes.
- Admin mutations require a valid signed cookie, exact `Origin`, and
  session-bound `x-csrf-token`.
- HTML uses a per-response CSP nonce, frame denial, `nosniff`, strict referrer
  policy, `form-action 'self'`, and `Cache-Control: no-store`.
- JSON schemas reject unknown fields. Redemption is capped at 64 KiB; the
  existing webhook retains its current 256 KiB global allowance.
- Logger redaction includes `session`, `authorization`, access/refresh/session/
  ID token aliases, `apikey`, `supabaseSecretKey`, and
  `SUPABASE_SECRET_KEY`, case-insensitively. Feature code is still forbidden
  from logging these values in the first place.
- Admin history projects an allowlist and omits `code_hash` entirely.
- No session/token is ever passed to Supabase. Supabase receives only hash,
  normalized email, workspace UUID, result code, and technical identifiers.

## Testing Strategy

- CDK unit tests cover format, normalization, HMAC determinism, entropy, and
  the rule that plaintext never enters store calls.
- Config/logger tests use secret and session sentinels and assert that the new
  secret-key format is required and redacted.
- Migration contract tests inspect schema, RLS/grants, singleton setting,
  immutable trigger, result checks, and the conditional RPC.
- A protected test-project integration suite, launched only from the VPS,
  invokes `consume_cdk` concurrently through independent backend clients and
  asserts exactly one returned row, `status='used'`, correct snapshot fields,
  and no possible reversal.
- Store unit tests inject a fake Supabase client and cover row decoding,
  hash-only issuance, RPC empty results, pagination, safe errors, finalization,
  and interrupted-result recovery.
- Session and ChatGPT client tests use fake JWTs/fetch and token sentinels; no
  live ChatGPT calls run in automated tests.
- Queue/worker tests prove email-only awaitable completion, all-job coalescing,
  per-job result projection, webhook-only history/normal reports, sequential
  Playwright access, and shutdown settlement without any workspace field.
- Redemption tests cover every pre/post-claim boundary, client disconnect,
  terminal-result write failure, and `finally` credential clearing.
- Fastify injection tests cover same-origin browser calls, cookie/CSRF/rate
  limits, body caps, no-store/security headers, exact admin capability set,
  warning copy, no revoke route, and absence of Supabase values in pages.
- Regression tests preserve `/health`, webhook authentication/normalization/
  exact `202` body, Telegram `/check` and `/clean`, JSON history, and the current
  `WorkspacePage.runAcceptFlow(page, emails)` signature.
- The final VPS smoke uses throwaway codes and browser submission without
  placing a real session, CDK, password, or secret in shell history or logs.

## Startup and Shutdown

Startup order is:

1. parse configuration and create the redacting logger;
2. create the server-only Supabase client and prove a safe settings read;
3. mark leftover `used/processing` rows `service_interrupted`;
4. start the existing browser and open the operator-selected Members page;
5. start queue/worker, Telegram bot, and then Fastify.

Shutdown first rejects new redemption/admin work, closes the queue so pending
redemptions settle, allows the in-flight Playwright batch to finish within the
existing operation timeouts, then closes Fastify, Telegram, and the browser.
The Supabase HTTP client has no SQLite-style file handle to close.

## Rollout and Rollback

1. Create a dedicated new `sb_secret_...` key for the AcceptGPT backend.
2. Apply the versioned Supabase migration and verify tables, trigger, RLS,
   privileges, and RPC before deploying application code.
3. Add `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CDK_HASH_SECRET`, admin secrets,
   and public origin to the protected VPS environment without printing values.
4. Upgrade the VPS runtime to Node.js 24, run locked install/tests/build, and
   deploy while preserving the Playwright profile and existing JSON history.
5. Sign in to admin, set `invite_workspace_id`, manually open Playwright in the
   same workspace, create one test CDK, and complete one smoke redemption.
6. Verify history shows the workspace snapshot and terminal result, then prove a
   second use fails. Repeat with an intentional post-claim failure and verify
   the row remains `used`.
7. Verify the legacy webhook, Telegram, health, and Caddy routes.

Rollback stops new CDK distribution, reverts the application revision and Node
dependencies, and leaves the Supabase schema/history intact as an audit record.
No rollback script may reset or delete used codes. Codes created by the new
feature are not redistributed while an older build that cannot redeem them is
running. Supabase key rotation is independent from CDK validity; a compromised
secret key is replaced and deleted according to Supabase's key-rotation flow.

## Source References

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase JavaScript RPC](https://supabase.com/docs/reference/javascript/rpc)
- [Supabase data security](https://supabase.com/docs/guides/database/secure-data)
