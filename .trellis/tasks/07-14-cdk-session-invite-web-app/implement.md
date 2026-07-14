# CDK Session Invite Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Fastify redemption/admin web flow in which Supabase Postgres stores one-way CDK state and one atomic RPC permanently claims a code only after its ChatGPT session has been validated.

**Architecture:** Browser code calls only same-origin Fastify APIs. Fastify uses a server-only Supabase client created from `SUPABASE_URL` and the new `SUPABASE_SECRET_KEY`; `consume_cdk` is the sole `unused -> used` transition. The submitted ChatGPT session remains request-local in RAM, while the existing Playwright flow receives only an email and stays entirely operator-managed with no workspace detection or synchronization.

**Tech Stack:** Node.js 24 LTS, TypeScript 5, Fastify 4, `@supabase/supabase-js` 2.x locked in `package-lock.json`, Playwright, `@fastify/cookie@9`, `@fastify/rate-limit@9`, Node test runner through `tsx --test`, Supabase Postgres, Caddy, and systemd.

## Global Constraints

- Keep one Fastify process, one systemd service, one Playwright persistent context, and one sequential acceptance worker.
- Public/admin browser code calls Fastify only. It contains no Supabase client, URL, publishable key, secret key, direct query, or RPC call.
- Production uses exactly `SUPABASE_URL` plus the new `SUPABASE_SECRET_KEY` (`sb_secret_...`) for Supabase access. The secret exists only in the protected VPS environment.
- `CDK_HASH_SECRET` and `ADMIN_SESSION_SECRET` are independent secrets; neither reuses the Supabase key.
- One non-expiring `XXXX-XXXX-XXXX-XXXX` CDK authorizes one validated session. Supabase stores only its HMAC-SHA-256 hash.
- `cdks.status` has only `unused|used`. The consume RPC is the sole transition, and no failure may restore `unused`.
- `result` begins as `processing`, then changes at most once to a terminal safe result. Result recording never controls reuse.
- Raw sessions/tokens never enter Supabase, queue jobs, JSON history, Telegram, screenshots, logs, error objects, URLs, browser storage, or responses.
- `app_settings` has one singleton row and only one editable business value: `invite_workspace_id`.
- Admin business capabilities are only workspace update, CDK creation, and history. There is no revoke, delete, reactivate, refund, or workspace-sync capability.
- Do not add a workspace argument/check/switch to `WorkspacePage.runAcceptFlow(page, emails)`. The admin warning is exactly: “Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK.”
- Preserve the existing webhook normalization/authentication/exact `202` response, webhook queue coalescing, Telegram `/check` and `/clean`, JSON history, browser profile, and session-expired behavior. The webhook remains independent of Supabase settings.
- Preserve unrelated dirty files. Never stage `.env`, `gptk12.txt`, `test/WEBHOOK-TEST-PLAN.md`, `WEBHOOK-INTEGRATION.md`, or unrelated Trellis/IDE changes.

## Target File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/202607140001_cdk_invite.sql` | Tables, one-way trigger, RLS/grants, atomic consume RPC |
| `src/supabase-types.ts` | Narrow typed schema/RPC contract |
| `src/supabase-client.ts` | Server-only Supabase client construction |
| `src/supabase-store.ts` | Settings, hash insertion, claim RPC, result, history |
| `src/cdk.ts` | CDK normalization, formatting, generation, HMAC |
| `src/cdk-issuer.ts` | Generate batch, insert hashes, return plaintext once |
| `src/domain-error.ts` | Stable allowlisted internal/public error contract |
| `src/session-input.ts` | Parse exactly one session and decode JWT claims |
| `src/chatgpt-join-client.ts` | Validate/request/accept/verify ChatGPT calls |
| `src/queue.ts` | Existing FIFO plus source, capacity, close, completion |
| `src/worker.ts` | Single Playwright consumer and per-job result projection |
| `src/redemption-service.ts` | Settings/session/RPC/join/worker/result orchestration |
| `src/admin-auth.ts` | Password, ephemeral admin sessions, CSRF |
| `src/web-pages.ts` | Public/admin HTML, CSS, same-origin JavaScript |
| `src/server.ts` | Existing webhook plus public/admin Fastify routes |
| `src/main.ts` | Dependency wiring, recovery, startup, shutdown |
| `test/*.test.ts` | Default isolated unit/route/regression tests |
| `test/supabase-rpc.integration.ts` | Explicit protected-project RPC race test |

---

### Task 1: Runtime Configuration, Dependencies, and Secret Redaction

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`
- Modify: `src/logger.ts`
- Modify: `.env.example`
- Create: `test/config.test.ts`
- Create: `test/logger.test.ts`

**Interfaces:**

- Produces `parseConfig(env: NodeJS.ProcessEnv): AppConfig` and cached
  `loadConfig()`.
- Produces `toServerConfig(config: AppConfig): ServerConfig`, whose type omits
  Supabase/CDK hash/admin-password values before Fastify receives configuration;
  it retains the separate cookie-signing secret required by `@fastify/cookie`.
- Produces `redactSensitive(value: unknown): unknown`.
- Adds `publicOrigin`, `supabaseUrl`, `supabaseSecretKey`, `adminPassword`,
  `adminSessionSecret`, `cdkHashSecret`, admin/rate-limit/queue/join settings to
  the existing `AppConfig` without removing current webhook/Telegram/browser
  settings.

- [ ] **Step 1: Write failing config and redaction tests**

Create a complete fake environment without any real credential:

```ts
const validEnv: NodeJS.ProcessEnv = {
  MEMBERS_URL: 'https://chatgpt.com/admin/members?tab=requests',
  TELEGRAM_BOT_TOKEN: 'telegram-test-token',
  TELEGRAM_CHAT_ID: '1',
  PUBLIC_ORIGIN: 'https://accept.example.com',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SECRET_KEY: `sb_secret_${'a'.repeat(40)}`,
  ADMIN_PASSWORD: 'correct horse battery staple',
  ADMIN_SESSION_SECRET: 'b'.repeat(32),
  CDK_HASH_SECRET: 'c'.repeat(32),
};

test('parseConfig accepts only the new server secret-key contract', () => {
  const config = parseConfig(validEnv);
  assert.equal(config.supabaseUrl, 'https://example-project.supabase.co');
  assert.match(config.supabaseSecretKey, /^sb_secret_/);
  assert.equal(config.maxQueueDepth, 100);
});

test('parseConfig rejects a legacy service-role JWT', () => {
  assert.throws(
    () => parseConfig({ ...validEnv, SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiJ9.legacy.jwt' }),
    /SUPABASE_SECRET_KEY.*sb_secret_/,
  );
});
```

In `test/logger.test.ts`, inject distinct session and Supabase sentinels into
nested objects, arrays, bindings, and `Error.message`; capture stdout in a
`try/finally`; assert neither sentinel is present and `[REDACTED]` is present.

- [ ] **Step 2: Run the focused tests and verify they fail for missing exports**

```powershell
npm.cmd exec -- tsx --test test/config.test.ts test/logger.test.ts
```

Expected: FAIL because `parseConfig`, new fields, and `redactSensitive` do not
exist.

- [ ] **Step 3: Install and lock server dependencies**

```powershell
npm.cmd install --save-exact @supabase/supabase-js@2 @fastify/cookie@9.4.0 @fastify/rate-limit@9.1.0
npm.cmd install --save-dev --save-exact @types/node@24
```

Add these scripts while preserving existing scripts:

```json
{
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "tsx --test",
    "test:supabase": "tsx --test test/supabase-rpc.integration.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "check": "npm run test && npm run typecheck && npm run build"
  }
}
```

Do not add `better-sqlite3`, `pg`, SQLite typings, or browser-specific
Supabase environment variables.

- [ ] **Step 4: Refactor configuration parsing**

Move environment reads behind helpers that receive `env`; make `loadConfig()`
the only cached `process.env` caller. Validate HTTPS origins/URLs, the
`sb_secret_` prefix, minimum 32-character independent secrets, UUID-independent
rate values, and these defaults:

```ts
const web = {
  adminSessionTtlMs: toIntFrom(env, 'ADMIN_SESSION_TTL_MS', 8 * 60 * 60 * 1000),
  redeemRateLimitMax: toIntFrom(env, 'REDEEM_RATE_LIMIT_MAX', 10),
  loginRateLimitMax: toIntFrom(env, 'LOGIN_RATE_LIMIT_MAX', 5),
  rateLimitWindowMs: toIntFrom(env, 'RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  maxQueueDepth: toIntFrom(env, 'MAX_QUEUE_DEPTH', 100),
  chatGptBaseUrl: optionalFrom(env, 'CHATGPT_BASE_URL', 'https://chatgpt.com').replace(/\/$/, ''),
  chatGptRequestTimeoutMs: toIntFrom(env, 'CHATGPT_REQUEST_TIMEOUT_MS', 30_000),
  joinMaxRetries: toIntFrom(env, 'JOIN_MAX_RETRIES', 3),
  joinRetryBackoffMs: toIntFrom(env, 'JOIN_RETRY_BACKOFF_MS', 5_000),
};
```

Do not define `APP_DATABASE_FILE`, `INITIAL_WORKSPACE_ID`, a publishable key, or
a service-role-key alias.

Implement `toServerConfig` as an explicit allowlist projection. Its returned
object must not have `supabaseSecretKey`, `cdkHashSecret`, or `adminPassword`;
add a compile/runtime test for all three omissions.

- [ ] **Step 5: Implement recursive redaction before serialization**

Use a normalized sensitive-key set and redact bearer/JWT/secret-looking text in
errors:

```ts
const SENSITIVE_KEYS = new Set([
  'session', 'authorization', 'apikey', 'supabasesecretkey',
  'supabase_secret_key', 'accesstoken', 'access_token', 'at',
  'refreshtoken', 'refresh_token', 'sessiontoken', 'session_token',
  'idtoken', 'id_token',
]);

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretText(value.message),
      stack: value.stack ? redactSecretText(value.stack) : undefined,
    };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item),
    ]));
  }
  return typeof value === 'string' ? redactSecretText(value) : value;
}
```

Apply redaction to the complete record before `JSON.stringify`. Document only
fake values in `.env.example` and state that `SUPABASE_SECRET_KEY` is VPS-only.

- [ ] **Step 6: Run verification and commit the runtime slice**

```powershell
npm.cmd exec -- tsx --test test/config.test.ts test/logger.test.ts
npm.cmd run typecheck
npm.cmd run build
git diff --check
git add package.json package-lock.json .env.example src/config.ts src/logger.ts test/config.test.ts test/logger.test.ts
git commit -m "chore: prepare server-only Supabase runtime"
```

Expected: tests/typecheck/build pass, diff check is silent, and the staged diff
contains no credential value.

---

### Task 2: Supabase Schema, One-Way Guard, and Atomic Consume RPC

**Files:**

- Create: `supabase/migrations/202607140001_cdk_invite.sql`
- Create: `test/migration-contract.test.ts`
- Create: `test/supabase-rpc.integration.ts`

**Interfaces:**

- Produces singleton `public.app_settings`.
- Produces `public.cdks` with status `unused|used` and safe result values.
- Produces `public.consume_cdk(p_code_hash text, p_email text,
  p_workspace_id uuid)` callable only by the backend role.
- Produces a database trigger that prevents hash mutation, `used -> unused`,
  identity/snapshot mutation after use, and terminal-result overwrite.

- [ ] **Step 1: Write a failing migration contract test**

The test reads the exact migration path and asserts structural/security
invariants instead of executing brittle substring snapshots:

```ts
const sql = readFileSync(
  'supabase/migrations/202607140001_cdk_invite.sql',
  'utf8',
).toLowerCase();

assert.match(sql, /create table public\.app_settings/);
assert.match(sql, /invite_workspace_id uuid/);
assert.match(sql, /create table public\.cdks/);
assert.match(sql, /status in \('unused', 'used'\)/);
assert.match(sql, /create or replace function public\.consume_cdk/);
assert.match(sql, /where code_hash = p_code_hash\s+and status = 'unused'/s);
assert.match(sql, /alter table public\.cdks enable row level security/);
assert.match(sql, /revoke all.*anon.*authenticated/s);
assert.match(sql, /revoke all on table public\.cdks from service_role/);
assert.match(sql, /revoke all on function public\.enforce_cdk_one_way\(\)/);
assert.doesNotMatch(sql, /create policy/);
assert.doesNotMatch(sql, /service_role_key|plaintext|code_hint/);
```

- [ ] **Step 2: Run the contract test and verify the migration is absent**

```powershell
npm.cmd exec -- tsx --test test/migration-contract.test.ts
```

Expected: FAIL with `ENOENT` for the migration.

- [ ] **Step 3: Implement the tables and indexes**

Create the schema exactly as defined in `design.md`, including these checks:

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
  status text not null default 'unused' check (status in ('unused', 'used')),
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

- [ ] **Step 4: Implement the immutable transition trigger**

Use fully qualified names and reject illegal changes:

```sql
create or replace function public.enforce_cdk_one_way()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code_hash is distinct from old.code_hash then
    raise exception 'CDK_HASH_IMMUTABLE';
  end if;
  if old.status = 'used' and new.status <> 'used' then
    raise exception 'CDK_CANNOT_RETURN_UNUSED';
  end if;
  if old.status = 'used' and (
    new.email is distinct from old.email
    or new.used_at is distinct from old.used_at
    or new.workspace_id is distinct from old.workspace_id
  ) then
    raise exception 'CDK_USAGE_SNAPSHOT_IMMUTABLE';
  end if;
  if old.result is distinct from new.result
     and old.result is not null
     and old.result <> 'processing' then
    raise exception 'CDK_RESULT_FINAL';
  end if;
  return new;
end;
$$;

create trigger cdks_enforce_one_way
before update on public.cdks
for each row execute function public.enforce_cdk_one_way();
```

- [ ] **Step 5: Implement the atomic RPC and privileges**

Use one conditional update and database `now()`:

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
    and nullif(btrim(p_email), '') is not null
    and p_workspace_id is not null
  returning cdks.id, cdks.email, cdks.workspace_id,
            cdks.used_at, cdks.result;
$$;

alter table public.app_settings enable row level security;
alter table public.cdks enable row level security;

revoke all on table public.app_settings from public, anon, authenticated;
revoke all on table public.cdks from public, anon, authenticated;
revoke all on table public.app_settings from service_role;
revoke all on table public.cdks from service_role;
revoke all on function public.enforce_cdk_one_way()
  from public, anon, authenticated;
revoke all on function public.consume_cdk(text, text, uuid)
  from public, anon, authenticated, service_role;

grant select on table public.app_settings to service_role;
grant update (invite_workspace_id, updated_at)
  on table public.app_settings to service_role;
grant select, insert on table public.cdks to service_role;
grant update (status, email, used_at, result, workspace_id)
  on table public.cdks to service_role;
grant execute on function public.enforce_cdk_one_way()
  to service_role;
grant execute on function public.consume_cdk(text, text, uuid)
  to service_role;
```

Do not create browser policies and do not grant `anon` or `authenticated` any
table/function permission.

- [ ] **Step 6: Add the protected RPC integration test**

`test/supabase-rpc.integration.ts` requires `SUPABASE_TEST_URL`,
`SUPABASE_TEST_SECRET_KEY`, `SUPABASE_TEST_PUBLISHABLE_KEY`, and the explicit
guard `SUPABASE_TEST_PROJECT=true`. It refuses to run without the guard, inserts
one random hash, creates an anon-role client from the publishable key, and races
two independent secret-key clients:

```ts
const [a, b] = await Promise.all([
  clientA.rpc('consume_cdk', args),
  clientB.rpc('consume_cdk', args),
]);
const winners = [a, b].filter((result) => !result.error && result.data?.length === 1);
const losers = [a, b].filter((result) => !result.error && result.data?.length === 0);
assert.equal(winners.length, 1);
assert.equal(losers.length, 1);

const row = await clientA.from('cdks')
  .select('status,email,workspace_id,result,used_at')
  .eq('code_hash', codeHash)
  .single();
assert.equal(row.data?.status, 'used');
assert.equal(row.data?.result, 'processing');
```

Also attempt `used -> unused`, hash mutation, terminal overwrite, anon select,
and anon RPC; each must fail. This suite runs only from the VPS against a
dedicated Supabase test project whose secret is stored in a protected VPS
environment file, never in source or shell history.

- [ ] **Step 7: Run the local contract test and commit the database slice**

```powershell
npm.cmd exec -- tsx --test test/migration-contract.test.ts
git diff --check
git add supabase/migrations/202607140001_cdk_invite.sql test/migration-contract.test.ts test/supabase-rpc.integration.ts
git commit -m "feat: define atomic Supabase CDK claim"
```

Expected: local contract test passes. Do not run the protected integration test
until the migration is applied to the dedicated test project.

---

### Task 3: CDK Primitives and Server-Only Supabase Store

**Files:**

- Create: `src/supabase-types.ts`
- Create: `src/supabase-client.ts`
- Create: `src/supabase-store.ts`
- Create: `src/cdk.ts`
- Create: `src/cdk-issuer.ts`
- Create: `src/domain-error.ts`
- Create: `test/cdk.test.ts`
- Create: `test/supabase-client.test.ts`
- Create: `test/supabase-store.test.ts`
- Create: `test/cdk-issuer.test.ts`

**Interfaces:**

- Produces the `CdkStatus`, `CdkResult`, `CdkStore`, `ClaimedCdk`,
  `CdkHistoryRecord`, and `CdkHistoryPage` contracts from `design.md`.
- Produces `createSupabaseClient(config)` and `SupabaseCdkStore`.
- Produces `normalizeCdk`, `formatCdk`, `hashCdk`, `generateCdk`.
- Produces `CdkIssuer.issue(count: number): Promise<string[]>`.
- Produces these shared types before later tasks consume them:

```ts
export type TerminalCdkResult = Exclude<CdkResult, 'processing'>;

export interface ClaimCdkInput {
  codeHash: string;
  email: string;
  workspaceId: string;
}

export type DomainErrorCode =
  | 'INVALID_CDK_COUNT'
  | 'CDK_GENERATION_FAILED'
  | 'CDK_HASH_COLLISION'
  | 'INVALID_INPUT'
  | 'CDK_INVALID_OR_USED'
  | 'SESSION_INVALID'
  | 'WORKSPACE_NOT_CONFIGURED'
  | 'SUPABASE_UNAVAILABLE'
  | 'JOIN_REJECTED'
  | 'ACCEPT_NOT_FOUND'
  | 'WORKER_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'INTERNAL_ERROR';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly publicMessage: string,
    readonly safeCauseCode?: string,
  ) {
    super(code);
    this.name = 'DomainError';
  }
}
```

- [ ] **Step 1: Write failing CDK and issuer tests**

Cover deterministic format/HMAC plus a real-random uniqueness check:

```ts
test('generated CDKs contain 80 random bits in four groups', () => {
  const generated = generateCdk('s'.repeat(32), () => Buffer.alloc(10, 0xff));
  assert.match(generated.plaintext, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.match(generated.codeHash, /^[0-9a-f]{64}$/);
});

test('normalization is case, whitespace, and hyphen insensitive', () => {
  assert.equal(normalizeCdk('  abcd-efgh-jkmn-pqrs '), 'ABCDEFGHJKMNPQRS');
});
```

The issuer fake records arguments. Assert it receives only 64-character hashes,
never plaintext; plaintext is returned only after the fake insert resolves; a
collision rejection regenerates the whole batch.

- [ ] **Step 2: Write failing client/store tests**

Use an injected fake Supabase client and assert:

- auth persistence options are all false;
- client construction receives the secret only as constructor input and never
  returns it;
- settings reads/updates target only row `id=1`;
- `hasUnusedCdk` selects only `id` by hash/status;
- `claimCdk` calls RPC with exactly `p_code_hash`, `p_email`, and
  `p_workspace_id`;
- an empty RPC array returns `null`;
- `finishCdk` filters `status='used'` and `result='processing'`;
- history selects an allowlist without `code_hash`;
- `markInterrupted` changes only `used/processing` rows;
- safe errors contain no secret/hash/response-body sentinel.

- [ ] **Step 3: Run focused tests and verify modules are missing**

```powershell
npm.cmd exec -- tsx --test test/cdk.test.ts test/cdk-issuer.test.ts test/supabase-client.test.ts test/supabase-store.test.ts
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement CDK generation and HMAC**

Use the fixed alphabet and 10 random bytes:

```ts
export function hashCdk(normalized: string, secret: string): string {
  return createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}

export function generateCdk(
  secret: string,
  random: (size: number) => Buffer = randomBytes,
): GeneratedCdk {
  const bytes = random(10);
  let bits = 0;
  let bitCount = 0;
  let normalized = '';
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      normalized += CDK_ALPHABET[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  const plaintext = formatCdk(normalized);
  return { plaintext, codeHash: hashCdk(normalized, secret) };
}
```

`normalizeCdk` removes ASCII whitespace/hyphens, uppercases, and validates
exactly 16 allowed characters without echoing raw input in errors.

- [ ] **Step 5: Implement server-only client and narrow types**

Create `Database` types only for the two tables and RPC. Construct the client:

```ts
export function createSupabaseClient(
  config: Pick<AppConfig, 'supabaseUrl' | 'supabaseSecretKey'>,
): AppSupabaseClient {
  return createClient<Database>(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
```

Do not export config values or import this module from browser-rendered script
code.

- [ ] **Step 6: Implement `SupabaseCdkStore` critical writes**

The claim and finalization methods are:

```ts
async claimCdk(input: ClaimCdkInput): Promise<ClaimedCdk | null> {
  const { data, error } = await this.client.rpc('consume_cdk', {
    p_code_hash: input.codeHash,
    p_email: input.email,
    p_workspace_id: input.workspaceId,
  });
  if (error) throw this.safeError('consume_cdk', error);
  const row = data?.[0];
  return row ? decodeClaimedCdk(row) : null;
}

async finishCdk(id: string, result: TerminalCdkResult): Promise<boolean> {
  const response = await this.client
    .from('cdks')
    .update({ result })
    .eq('id', id)
    .eq('status', 'used')
    .eq('result', 'processing')
    .select('id');
  if (response.error) throw this.safeError('finish_cdk', response.error);
  return response.data.length === 1;
}
```

Implement every other `CdkStore` method with explicit select projections and
row decoders from `unknown`. Define `decodeClaimedCdk` next to the store and
require UUID, normalized email, UUID workspace, ISO timestamp, and literal
`processing`. `setInviteWorkspaceId` updates `id=1` plus `updated_at`; it never
inserts arbitrary settings. `insertCdkHashes` accepts hash strings only. Map
Postgres code `23505` to `DomainError('CDK_HASH_COLLISION', ...)`; the local
`isUniqueHashCollision` helper checks that code. No method returns `code_hash`
in history.

- [ ] **Step 7: Implement one-time batch issuance**

```ts
export class CdkIssuer {
  constructor(
    private readonly store: Pick<CdkStore, 'insertCdkHashes'>,
    private readonly hashSecret: string,
  ) {}

  async issue(count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new DomainError('INVALID_CDK_COUNT');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const batch = Array.from({ length: count }, () => generateCdk(this.hashSecret));
      try {
        await this.store.insertCdkHashes(batch.map((item) => item.codeHash));
        return batch.map((item) => item.plaintext);
      } catch (error) {
        if (!isUniqueHashCollision(error) || attempt === 2) throw error;
      }
    }
    throw new DomainError('CDK_GENERATION_FAILED');
  }
}
```

No logger call receives `batch` or the returned strings.

- [ ] **Step 8: Run tests, typecheck, and commit the store slice**

```powershell
npm.cmd exec -- tsx --test test/cdk.test.ts test/cdk-issuer.test.ts test/supabase-client.test.ts test/supabase-store.test.ts
npm.cmd run typecheck
git diff --check
git add src/supabase-types.ts src/supabase-client.ts src/supabase-store.ts src/cdk.ts src/cdk-issuer.ts src/domain-error.ts test/cdk.test.ts test/cdk-issuer.test.ts test/supabase-client.test.ts test/supabase-store.test.ts
git commit -m "feat: add server-only Supabase CDK store"
```

Expected: all tests/typecheck pass and sentinel scans prove store arguments
contain hashes but no plaintext/session/secret.

---

### Task 4: Single-Session Parser and Candidate Join Client

**Files:**

- Create: `src/session-input.ts`
- Create: `src/chatgpt-join-client.ts`
- Create: `test/session-input.test.ts`
- Create: `test/chatgpt-join-client.test.ts`

**Interfaces:**

- Produces `SessionCredentials`, `SessionClaims`, `parseSingleSession`, and
  `decodeSessionClaims` from `design.md`.
- Produces `ChatGptJoinClient` implementing `validateSession`, `requestJoin`,
  and `verifyMembership`.
- Consumes ChatGPT base URL, timeout, retry, and backoff config from Task 1.

- [ ] **Step 1: Write failing parser tests**

Build unsigned JWTs inside tests only. Cover raw token and three aliases:

```ts
for (const input of [token, { accessToken: token }, { access_token: token }, { at: token }]) {
  const credentials = parseSingleSession(input);
  assert.equal(credentials.accessToken, token);
  credentials.clear();
  assert.equal(credentials.accessToken, '');
}

assert.throws(() => parseSingleSession([token]), /SESSION_BATCH_NOT_ALLOWED/);
assert.throws(() => parseSingleSession(`${token}\n${token}`), /SESSION_BATCH_NOT_ALLOWED/);
```

Also cover malformed base64/JSON/JWT, missing namespaced email/account ID,
expired `exp`, extra object fields, and errors that never echo the token.

- [ ] **Step 2: Write failing join-client tests**

Inject fake `fetch`, sleep, and UUID providers. Assert exact request order:

```ts
assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
  `POST /backend-api/accounts/${workspaceId}/invites/request`,
  `POST /backend-api/accounts/${workspaceId}/invites/accept`,
  'GET /backend-api/accounts/check/v4-2023-04-27',
  'GET /backend-api/me',
]);
```

Cover bearer/device/language/content headers, no cookie, `409` ambiguity,
retry-only network/timeout/429/5xx, no retry for 401/403/404/422, structural
membership parsing, email equality, and response/token sentinel redaction.

- [ ] **Step 3: Run tests and verify both modules are absent**

```powershell
npm.cmd exec -- tsx --test test/session-input.test.ts test/chatgpt-join-client.test.ts
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement one-session parsing**

Accept only a string or plain object. Copy only the access token into a mutable
holder:

```ts
export class MutableSessionCredentials implements SessionCredentials {
  constructor(public accessToken: string) {}
  clear(): void {
    this.accessToken = '';
  }
}
```

Decode with `Buffer.from(segment, 'base64url')`, normalize email to lowercase,
require namespaced ChatGPT account ID and future numeric `exp`, and do not port
export, cookie, localStorage, account-switch, or K12-name features.

- [ ] **Step 5: Implement cookie-less ChatGPT calls**

Use request-local device UUID and `AbortSignal.timeout`:

```ts
export class ChatGptJoinClient implements JoinClient {
  constructor(
    private readonly options: JoinClientOptions,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly uuid: () => string = randomUUID,
  ) {}
}
```

Parse JSON as `unknown` with type guards. `validateSession` must remotely
confirm the canonical email/account and match decoded claims. `requestJoin`
uses only the workspace snapshot argument. Safe errors contain status/code and
attempt number, never authorization or response content.

- [ ] **Step 6: Verify and commit the session/join slice**

```powershell
npm.cmd exec -- tsx --test test/session-input.test.ts test/chatgpt-join-client.test.ts
npm.cmd run typecheck
git diff --check
git add src/session-input.ts src/chatgpt-join-client.ts test/session-input.test.ts test/chatgpt-join-client.test.ts
git commit -m "feat: validate one session and request workspace join"
```

Expected: tests/typecheck pass and token/body sentinels are absent from every
captured log/error/result.

---

### Task 5: Email-Only Awaitable Queue and Existing Worker Projection

**Files:**

- Modify: `src/queue.ts`
- Modify: `src/worker.ts`
- Create: `test/queue.test.ts`
- Create: `test/worker.test.ts`

**Interfaces:**

- Produces `JobSource`, `JobCompletion`, `AwaitableJob`,
  `createWebhookJob(emails)`, and `createAwaitableJob(emails)`.
- Produces bounded `JobQueue.enqueue`, `take`, `drainAll`, and `close`.
- Preserves `WorkspacePage.runAcceptFlow(page, emails)` unchanged.
- Preserves webhook-source Telegram/JSON-history side effects while returning
  redemption completion to its caller.

- [ ] **Step 1: Write failing queue tests**

Cover FIFO, capacity, one-time completion, close, and the absence of forbidden
fields:

```ts
const ticket = createAwaitableJob(['user@example.com']);
assert.equal(ticket.job.source, 'redemption');
assert.equal('workspaceId' in ticket.job, false);
assert.equal('session' in ticket.job, false);
assert.equal('codeHash' in ticket.job, false);

queue.enqueue(ticket.job);
queue.close({ kind: 'error', code: 'worker-stopped' });
assert.deepEqual(await ticket.completion, { kind: 'error', code: 'worker-stopped' });
assert.equal(await queue.take(), null);
```

Assert repeated completion calls settle the promise only once and closed/full
queues reject without retaining job references.

- [ ] **Step 2: Write failing worker tests**

Use fakes for browser, workspace page, Telegram, history, and logger. Prove:

- webhook and redemption jobs coalesce into one exact-email Playwright call;
- each redemption ticket receives only its own email result;
- only webhook-source results enter normal Telegram summaries and JSON history;
- redemption-only processed results do not enter `/check` history;
- session expiry keeps the current operator alert and settles all tickets;
- error/browser-retry/stop settle all tickets exactly once;
- maximum concurrent `runAcceptFlow` remains one;
- no worker call passes a third workspace argument.

- [ ] **Step 3: Run tests and verify completion/close behavior is missing**

```powershell
npm.cmd exec -- tsx --test test/queue.test.ts test/worker.test.ts
```

Expected: FAIL because current jobs have no source/completion and the queue
cannot close.

- [ ] **Step 4: Extend jobs without a workspace contract**

```ts
export interface Job {
  id: string;
  emails: string[];
  receivedAt: number;
  source: 'webhook' | 'redemption';
  complete?: (result: JobCompletion) => void;
}

export function createWebhookJob(emails: string[]): Job {
  return { id: randomUUID(), emails, receivedAt: Date.now(), source: 'webhook' };
}
```

`createAwaitableJob` uses a closure-local settled flag. `JobQueue(maxDepth)`
rejects full/closed enqueue, `take()` returns `null` after close, and `close()`
settles queued/waiting tickets. Keep `drainAll()`; do not add `drainMatching`.

- [ ] **Step 5: Project the one Playwright result to original jobs**

Keep `runAcceptFlow(page, emails)` unchanged and map results:

```ts
const byEmail = new Map(outcome.results.map((item) => [item.email, item]));
for (const job of jobs) {
  job.complete?.({
    kind: 'processed',
    results: job.emails.map((email) =>
      byEmail.get(email) ?? { email, status: 'not-found' }),
    count: outcome.count,
  });
}
```

Build Telegram/history reporting from webhook-source emails only. Preserve the
existing session-expired alert. Add `isReadyForRedemptions` and close pending
tickets when the worker can no longer accept work.

- [ ] **Step 6: Run regression gates and commit the queue slice**

```powershell
npm.cmd exec -- tsx --test test/queue.test.ts test/worker.test.ts
npm.cmd run typecheck
npm.cmd run build
git diff --check
git add src/queue.ts src/worker.ts test/queue.test.ts test/worker.test.ts
git commit -m "refactor: await Playwright results with email-only jobs"
```

Expected: all gates pass, `src/workspace-page.ts` is not changed, and no queue
type includes a workspace/session/CDK/Supabase field.

---

### Task 6: Irreversible Redemption Orchestrator

**Files:**

- Create: `src/redemption-service.ts`
- Create: `test/redemption-service.test.ts`

**Interfaces:**

- Produces `RedemptionService.redeem({ cdk, session }):
  Promise<RedemptionResult>`.
- Consumes `CdkStore`, `JoinClient`, `JobQueue`, worker readiness,
  `parseSingleSession`, `decodeSessionClaims`, and `CDK_HASH_SECRET`.
- Produces public-safe codes `INVALID_INPUT`, `CDK_INVALID_OR_USED`,
  `SESSION_INVALID`, `WORKSPACE_NOT_CONFIGURED`, `SUPABASE_UNAVAILABLE`,
  `JOIN_REJECTED`, `ACCEPT_NOT_FOUND`, `WORKER_UNAVAILABLE`,
  `UPSTREAM_TIMEOUT`, and `INTERNAL_ERROR`.

- [ ] **Step 1: Write the failure-boundary matrix first**

Use fakes that record event order and recursively scan all arguments for a token
sentinel:

| Scenario | Claim RPC? | Final status | Result |
|---|---:|---|---|
| Missing workspace | No | unchanged | N/A |
| Invalid/missing CDK hash | No | unchanged | N/A |
| Malformed/expired session | No | `unused` | null |
| Remote session validation fails | No | `unused` | null |
| RPC loses the race | Called, no row | other request owns row | N/A |
| Already member | Yes | `used` | `already_member` |
| Candidate/worker accepts | Yes | `used` | `accepted` |
| Worker not found | Yes | `used` | `accept_not_found` |
| Join rejected | Yes | `used` | `join_rejected` |
| Worker unavailable | Yes | `used` | `worker_unavailable` |
| Timeout/unexpected error after claim | Yes | `used` | safe terminal code |
| Result write fails | Yes | `used` | remains `processing` |

The success-order assertion is:

```ts
assert.deepEqual(events, [
  'settings.read',
  'cdk.hash',
  'cdk.inspect',
  'session.parse',
  'session.validate',
  'cdk.rpc-claim',
  'join.request-and-accept',
  'queue.enqueue-email-only',
  'queue.complete',
  'cdk.result.accepted',
  'session.clear',
]);
```

Assert `cdk.rpc-claim` always occurs after `session.validate`. The token sentinel
may appear only inside the active fake join-client call, never in store/queue/
logger/result/error arguments.

- [ ] **Step 2: Run the focused test and verify the service is absent**

```powershell
npm.cmd exec -- tsx --test test/redemption-service.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the orchestration boundary**

Use constructor interfaces and this exact control shape:

```ts
async redeem(input: { cdk: unknown; session: unknown }): Promise<RedemptionResult> {
  let credentials: SessionCredentials | null = null;
  let claimed: ClaimedCdk | null = null;
  try {
    const workspaceId = await this.requireWorkspaceSnapshot();
    const normalized = this.requireNormalizedCdk(input.cdk);
    const codeHash = hashCdk(normalized, this.cdkHashSecret);
    await this.requirePossiblyUnused(codeHash);

    credentials = parseSingleSession(input.session);
    const claims = decodeSessionClaims(credentials.accessToken);
    const identity = await this.joinClient.validateSession(credentials, claims);

    claimed = await this.store.claimCdk({
      codeHash,
      email: identity.email,
      workspaceId,
    });
    if (!claimed) return this.publicFailure('CDK_INVALID_OR_USED');

    const join = await this.joinClient.requestJoin(credentials, workspaceId);
    if (join.membership === 'member') {
      return await this.finishSuccess(claimed, 'already_member');
    }

    const ticket = createAwaitableJob([identity.email]);
    this.queue.enqueue(ticket.job);
    const completion = await ticket.completion;
    this.assertAccepted(identity.email, completion);
    return await this.finishSuccess(claimed, 'accepted');
  } catch (error) {
    return await this.failSafely(claimed, error);
  } finally {
    credentials?.clear();
    credentials = null;
  }
}
```

`requirePossiblyUnused` is only a fast rejection; it never replaces RPC. The
queue ticket contains only normalized email. There is no Playwright workspace
read/check/update.

- [ ] **Step 4: Implement post-claim failure finalization**

Map allowlisted domain codes to terminal result codes. Once `claimed` exists,
attempt one guarded finalization and never call any status-reset operation:

```ts
const RESULT_BY_ERROR: Record<
  'JOIN_REJECTED' | 'ACCEPT_NOT_FOUND' | 'WORKER_UNAVAILABLE'
    | 'UPSTREAM_TIMEOUT' | 'INTERNAL_ERROR' | 'SUPABASE_UNAVAILABLE',
  TerminalCdkResult
> = {
  JOIN_REJECTED: 'join_rejected',
  ACCEPT_NOT_FOUND: 'accept_not_found',
  WORKER_UNAVAILABLE: 'worker_unavailable',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  INTERNAL_ERROR: 'internal_error',
  SUPABASE_UNAVAILABLE: 'internal_error',
};

function toSafeRedemptionError(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError('INTERNAL_ERROR', 'Không thể hoàn tất yêu cầu.');
}

function terminalResultFor(code: DomainErrorCode): TerminalCdkResult {
  return RESULT_BY_ERROR[code as keyof typeof RESULT_BY_ERROR] ?? 'internal_error';
}

private async failSafely(
  claimed: ClaimedCdk | null,
  error: unknown,
): Promise<RedemptionResult> {
  const safe = toSafeRedemptionError(error);
  if (claimed) {
    const result = terminalResultFor(safe.code);
    await this.store.finishCdk(claimed.id, result).catch((finishError) => {
      this.logger.error('Không ghi được kết quả CDK đã dùng', {
        cdkId: claimed.id,
        code: safe.code,
        err: finishError,
      });
    });
  }
  return { ok: false, code: safe.code, message: safe.publicMessage };
}
```

No logged error contains raw `Error.message` from ChatGPT/Supabase or any input
value. A failed finalization intentionally leaves `used/processing` for startup
recovery.

- [ ] **Step 5: Prove disconnect and restart semantics**

Add a test that resolves the simulated HTTP lifecycle before the worker ticket,
then completes the ticket. Assert result becomes `accepted` and status remains
used. Add a separate test where finalization rejects; assert there is no store
method capable of restoring `unused` and startup `markInterrupted()` changes
only result to `service_interrupted`.

- [ ] **Step 6: Run cross-layer tests and commit the orchestrator**

```powershell
npm.cmd exec -- tsx --test test/redemption-service.test.ts test/supabase-store.test.ts test/queue.test.ts
npm.cmd run typecheck
git diff --check
git add src/redemption-service.ts test/redemption-service.test.ts
git commit -m "feat: consume CDKs before invite and accept"
```

Expected: all pre-claim failures leave rows unused; every post-claim branch is
used; token sentinel appears nowhere durable or observable.

---

### Task 7: Administrator Authentication and CSRF Lifecycle

**Files:**

- Create: `src/admin-auth.ts`
- Create: `test/admin-auth.test.ts`

**Interfaces:**

- Produces `AdminAuth.create`, `login`, `authenticate`, `assertMutation`,
  `logout`, and `close`.
- Consumes admin password, independent session secret, public origin, TTL, and
  injectable clock/random providers.

- [ ] **Step 1: Write failing authentication lifecycle tests**

Cover wrong password, generic response, fixed-length scrypt comparison, session
rotation, signed-cookie lookup, CSRF, exact origin, expiry, logout, bounded map,
and restart:

```ts
const auth = await AdminAuth.create(options);
const session = await auth.login('correct horse battery staple');
assert.ok(session);
assert.doesNotThrow(() =>
  auth.assertMutation(session, session.csrfToken, options.publicOrigin));
assert.throws(() =>
  auth.assertMutation(session, 'wrong', options.publicOrigin), /CSRF_REJECTED/);
assert.throws(() =>
  auth.assertMutation(session, session.csrfToken, 'https://evil.example'), /CSRF_REJECTED/);
```

Assert password, cookie ID, CSRF token, and Supabase sentinel never appear in
logs/errors.

- [ ] **Step 2: Run the test and verify the module is absent**

```powershell
npm.cmd exec -- tsx --test test/admin-auth.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement secure ephemeral sessions**

Derive the configured verifier once with asynchronous `crypto.scrypt`; derive
submitted values with the same domain-separated salt and compare fixed-length
buffers using `timingSafeEqual`. Generate independent 32-byte session and CSRF
tokens. Export cookie constants once:

```ts
export const ADMIN_COOKIE_NAME = '__Host-acceptgpt_admin';
export const ADMIN_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'strict' as const,
  signed: true,
};
```

Use an eight-hour absolute expiry without refresh. Restart creates an empty map.
AdminAuth exposes authentication mechanics only; it contains no Supabase or
business-operation method.

- [ ] **Step 4: Verify and commit admin auth**

```powershell
npm.cmd exec -- tsx --test test/admin-auth.test.ts
npm.cmd run typecheck
git diff --check
git add src/admin-auth.ts test/admin-auth.test.ts
git commit -m "feat: add secure web administrator sessions"
```

Expected: tests/typecheck pass and captured output contains no secret.

---

### Task 8: Public/Admin Pages and Fastify API Routes

**Files:**

- Create: `src/web-pages.ts`
- Modify: `src/server.ts`
- Create: `test/web-pages.test.ts`
- Create: `test/server.test.ts`

**Interfaces:**

- Produces `renderRedeemPage(nonce)` and `renderAdminPage(nonce)`.
- Produces the route table in `design.md` and
  `buildServer(serverConfig, logger, ServerDependencies)`.
- Consumes `RedemptionService`, `CdkStore`, `CdkIssuer`, `AdminAuth`,
  `JobQueue`, and worker readiness through injected interfaces only.

- [ ] **Step 1: Write failing page-security tests**

Render each page with sentinels and assert:

```ts
assert.match(adminHtml, /Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK\./);
assert.match(redeemHtml, /CDK.*đã dùng.*không.*hoàn lại/is);
assert.doesNotMatch(adminHtml + redeemHtml, /supabase|sb_secret_|createClient|service_role/i);
assert.doesNotMatch(adminHtml, /revoke|thu hồi|xóa CDK|đổi workspace Playwright/i);
```

Also assert browser scripts use only `/api/...` fetch URLs, render database
values with `textContent`, never use `innerHTML` for data, and never use
localStorage/sessionStorage/cookies/console for CDK/session/result data.

- [ ] **Step 2: Write failing Fastify injection tests**

Cover:

- unchanged `/health` status and queue count;
- unchanged webhook secret, normalization, and exact
  `202 { queued: true, jobId, count }`;
- `GET /` and `GET /admin` no-store/security headers;
- `POST /api/redeem` 64 KiB body limit, rate limit, terminal response, and no
  token reflection;
- generic admin-login failure and separate login rate limit;
- signed `__Host-` cookie flags;
- admin state/history requires auth and omits `code_hash`;
- workspace PUT rejects non-UUID/wrong Origin/wrong CSRF;
- CDK generation accepts only count 1-100, returns plaintext once, and is
  `no-store`;
- `POST /api/admin/cdks/:id/revoke` and every delete/reactivate route return
  `404`;
- pages/responses never contain config Supabase URL/key sentinels.

Keep the legacy regression exact:

```ts
const response = await app.inject({
  method: 'POST',
  url: '/webhook',
  headers: { 'x-webhook-secret': 'test-secret' },
  payload: { emails: [' User@Example.com ', 'user@example.com'] },
});
assert.equal(response.statusCode, 202);
assert.deepEqual(response.json(), { queued: true, jobId: fakeJobId, count: 1 });
```

- [ ] **Step 3: Run route/page tests and verify features are absent**

```powershell
npm.cmd exec -- tsx --test test/web-pages.test.ts test/server.test.ts
```

Expected: FAIL because pages, plugins, dependencies, and routes do not exist.

- [ ] **Step 4: Implement dependency-free same-origin pages**

`renderRedeemPage` has one CDK input and one session textarea. Its nonce script
constructs the JSON body, clears the textarea and local session variable
immediately, disables duplicate submission, and renders only safe returned text.

`renderAdminPage` keeps CSRF in JS memory, loads `/api/admin/state`, updates
`invite_workspace_id`, creates a batch, displays/copies it once, and renders
history. It has no revoke control. Place the exact Playwright warning adjacent
to workspace and generation controls.

Use HTML escaping for static interpolation and `textContent` for all dynamic
values. Do not embed any server config except the fresh CSP nonce.

- [ ] **Step 5: Refactor Fastify registration and security hooks**

Create `ServerDependencies` exactly as in `design.md`. Accept only
`ServerConfig`, never the full `AppConfig`. Construct Fastify with
`logger:false`, existing 256 KiB global limit, and loopback-only proxy trust.
Register cookie first and rate-limit with `global:false`.

Set HTML headers:

```ts
reply.headers({
  'cache-control': 'no-store',
  'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});
```

Authenticated mutations share a pre-handler that validates signed cookie,
AdminAuth session, exact Origin, and `x-csrf-token`. Route handlers call store/
issuer only after this gate. Never serialize `config`, client, low-level errors,
or hashes.

The webhook continues to call `createWebhookJob(emails)` directly. It never
reads `invite_workspace_id` and keeps the current success/error payloads.

- [ ] **Step 6: Run full route/security regression and commit**

```powershell
npm.cmd exec -- tsx --test test/web-pages.test.ts test/server.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
git add src/web-pages.ts src/server.ts test/web-pages.test.ts test/server.test.ts
git commit -m "feat: add Fastify-only CDK and admin pages"
```

Expected: all gates pass; exact warning is rendered; no Supabase value reaches
client output; webhook behavior is unchanged; revoke/delete routes are absent.

---

### Task 9: Process Wiring, Deployment, Operator Guide, and End-to-End Gates

**Files:**

- Modify: `src/main.ts`
- Modify: `deploy/vps-setup.sh`
- Modify: `deploy/wsl-setup.sh`
- Modify: `deploy/Caddyfile`
- Modify: `deploy/REVERSE-PROXY.md`
- Modify: `deploy/WSL.md`
- Create: `CDK-WEB-APP.md`
- Create: `test/main-wiring.test.ts`

**Interfaces:**

- Consumes every component from Tasks 1-8.
- Produces `buildApplication(config, logger)` for injectable composition.
- Produces startup `markInterrupted`, store-read readiness, safe shutdown, and
  the final operational checklist.
- Preserves one loopback Fastify listener and the current systemd unit.

- [ ] **Step 1: Write a failing composition test**

Inject fakes and assert startup order:

```ts
assert.deepEqual(startEvents, [
  'supabase.client.create',
  'supabase.settings.read',
  'supabase.mark-interrupted',
  'browser.start',
  'workspace.open-members',
  'worker.start',
  'telegram-bot.start',
  'server.listen',
]);
```

Assert a Supabase readiness/migration-contract failure is fatal before browser
or HTTP startup. Assert shutdown first rejects new work, closes/settles the
queue, lets the in-flight worker finish within a bound, then closes HTTP,
Telegram, and browser. There is no database-file close event.

- [ ] **Step 2: Run the composition test and verify main is not injectable**

```powershell
npm.cmd exec -- tsx --test test/main-wiring.test.ts
```

Expected: FAIL because `main.ts` immediately executes and has no Supabase
composition factory.

- [ ] **Step 3: Wire store, services, worker, auth, and server**

Construct in this order:

```ts
const client = createSupabaseClient(config);
const store = new SupabaseCdkStore(client, logger.child({ component: 'supabase' }));
await store.getInviteWorkspaceId();
await store.markInterrupted();

const issuer = new CdkIssuer(store, config.cdkHashSecret);
const queue = new JobQueue(config.maxQueueDepth);
const worker = new Worker(config, logger, queue, browser, workspace, telegram, history);
const redemptions = new RedemptionService({
  store, queue, worker, joinClient, cdkHashSecret: config.cdkHashSecret, logger,
});
const adminAuth = await AdminAuth.create(adminOptions);
const app = buildServer(toServerConfig(config), logger, {
  queue, worker, redemptions, cdkStore: store, cdkIssuer: issuer, adminAuth,
});
```

Do not log the config object. Preserve current browser/Telegram/history startup
behavior. On shutdown, stop accepting new public/admin work before closing
queue waiters; avoid waiting for Fastify while a redemption is still waiting on
an unclosed queue.

- [ ] **Step 4: Upgrade setup scripts without native database packages**

Both VPS and WSL scripts use NodeSource `setup_24.x` when upgrade is required,
then run `npm ci`, Playwright Chromium install, tests/build as appropriate. Keep
existing OS/browser packages, but do not add `build-essential`, `make`, `g++`,
SQLite tools, or a local Postgres server for this feature.

Scripts must never create/overwrite `.env`, print secret values, or put them on
command lines. Update WSL/deploy docs from Node 20 to Node 24 and state that
outbound HTTPS to the configured Supabase project is required.

- [ ] **Step 5: Expose only approved HTTPS routes in Caddy**

Use this allowlist while preserving compression/TLS:

```caddyfile
@allowed {
    path / /api/redeem /admin /api/admin/* /webhook /health
}
handle @allowed {
    reverse_proxy 127.0.0.1:8080
}
handle {
    respond "Not found" 404
}
```

If `WEBHOOK_PATH` differs in production, keep the Caddy matcher synchronized
without exposing any new Supabase route. Document safe `HEAD`/health checks
that never put CDKs, passwords, sessions, or secrets in URLs.

- [ ] **Step 6: Write the operator guide**

`CDK-WEB-APP.md` documents:

- applying/verifying `202607140001_cdk_invite.sql` before application deploy;
- creating a dedicated new `sb_secret_...` key and placing URL/key only in the
  protected VPS environment;
- generating independent admin/session/CDK-hash secrets without echoing them to
  chat, Git, process arguments, or logs;
- first admin login and `invite_workspace_id` update;
- manually switching Playwright to that workspace before creating/distributing
  codes, with the exact warning text;
- one-time plaintext creation, non-expiry, no revoke/refund, and history result
  meanings;
- `used/processing -> service_interrupted` restart behavior;
- secret-key rotation without CDK invalidation, contrasted with
  `CDK_HASH_SECRET` rotation;
- no SQLite/WAL backup step; Supabase backup/retention is managed at the project
  level;
- rollback retaining all Supabase rows and never resetting used codes;
- `gptk12.txt` as research input only.

Do not edit or stage `WEBHOOK-INTEGRATION.md` because it may contain sensitive
material outside this task.

- [ ] **Step 7: Apply migration and run protected RPC proof**

After explicit deployment/test-project approval, apply the migration using the
Supabase Dashboard or authenticated CLI on the VPS. Store the dedicated test
project values in a protected environment file and run:

```powershell
npm.cmd run test:supabase
```

Expected: exactly one concurrent claim winner; no anon/authenticated access;
illegal status/hash/result mutations fail. Remove the temporary test-project
secret from the process environment after the run. Never paste it into chat or
commit it.

- [ ] **Step 8: Run complete local verification and inspect scope**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
git status --short
git diff --cached --name-only
```

Expected: all code gates pass; diff check is silent; no `.env`, secret, SQLite
file, `gptk12.txt`, `WEBHOOK-INTEGRATION.md`, `test/WEBHOOK-TEST-PLAN.md`, or
unrelated Trellis/IDE file is staged.

- [ ] **Step 9: Commit the wiring/deployment slice**

```powershell
git add src/main.ts deploy/vps-setup.sh deploy/wsl-setup.sh deploy/Caddyfile deploy/REVERSE-PROXY.md deploy/WSL.md CDK-WEB-APP.md test/main-wiring.test.ts
git commit -m "feat: deploy Supabase-backed CDK invite web app"
```

- [ ] **Step 10: Run the guarded VPS smoke checklist after deployment approval**

Use the HTTPS browser UI for any real CDK/session/admin action. Safe shell checks
are limited to non-secret state:

```bash
systemctl is-active accept-gpt
curl -fsS https://accept.nguyenhoanganh.dev/health
curl -fsSI https://accept.nguyenhoanganh.dev/
curl -fsSI https://accept.nguyenhoanganh.dev/admin
journalctl -u accept-gpt -n 100 --no-pager
```

Verify:

- service is active and health reports `status: ok`;
- public/admin pages return HTTPS 200 with no-store/security headers;
- admin can edit only Invite Workspace ID, create codes, and view history;
- the exact Playwright warning is visible;
- after manually opening Playwright in the matching workspace, one throwaway
  CDK reaches `used` with a terminal result;
- second use of that code fails;
- one intentional post-claim invite/accept failure still leaves `used`;
- existing webhook still returns exact `202` and produces established
  Telegram/history behavior;
- journal, HTML, JSON responses, and Supabase application-owned text columns
  contain no raw session, token, secret key, or plaintext CDK sentinel;
- no code path changes, verifies, or synchronizes Playwright's workspace.

If undocumented ChatGPT response shapes differ, keep any already-claimed code
used, capture only HTTP status plus redacted field names, update adapter tests,
and redeploy. Never dump bodies, bearer values, or browser credentials.

---

## Final Review Gate

Before `task.py start`, review `prd.md`, `design.md`, and this plan together and
confirm:

- every PRD acceptance criterion maps to a named test or VPS check;
- production config uses `SUPABASE_URL`/new `SUPABASE_SECRET_KEY`, never a
  browser key or legacy service-role JWT variable;
- browser code calls Fastify only and no response/page contains Supabase data;
- `consume_cdk` occurs only after remote session validation and is the sole
  `unused -> used` path;
- the RPC writes email, database use time, `processing`, and the request's
  workspace snapshot atomically;
- post-claim invite/accept/result/network/process failures never restore unused;
- session/token values never cross the `RedemptionService`/`ChatGptJoinClient`
  request-local boundary;
- queue jobs contain email/source/completion only, with no workspace/session/
  CDK/Supabase fields;
- existing `WorkspacePage.runAcceptFlow(page, emails)` remains unchanged and no
  Playwright workspace detection/switch/sync code exists;
- admin exposes only Invite Workspace ID, create, history, and supporting
  authentication/copy/pagination controls; revoke/delete routes are absent;
- both the irreversible-use notice and exact admin Playwright warning are
  rendered and tested;
- webhook, Telegram, JSON history, health, browser profile, and session-expired
  regressions remain independent of Supabase settings;
- protected integration proof, local tests, typecheck, build, and diff check all
  pass before implementation is reported complete.
