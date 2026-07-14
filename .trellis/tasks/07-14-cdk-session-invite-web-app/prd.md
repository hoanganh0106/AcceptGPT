# CDK Session Invite Web App

## Goal

Add a public Fastify web flow where one non-expiring, single-use CDK authorizes
one validated ChatGPT session to request and complete entry into one
administrator-configured workspace. Replace the proposed local SQLite storage
with Supabase Postgres while keeping all Supabase access inside the backend.

The submitted ChatGPT session is temporary request data. It must exist only in
RAM while the request is being processed and must never be stored in Supabase,
files, logs, queue payloads, Telegram messages, or browser storage.

## User Roles

- **Redeemer:** submits one CDK and one ChatGPT session to Fastify and receives
  one final, sanitized success or error result.
- **Administrator:** signs in to the Fastify admin page, edits the single
  `invite_workspace_id` setting, creates CDKs, and views CDK history.

## Requirements

### Browser and backend boundary

- Public and admin browser code calls only same-origin Fastify routes.
- Browser code must not initialize a Supabase client or receive a Supabase URL,
  publishable key, secret key, service-role key, database credential, or direct
  database endpoint.
- Fastify owns every read, insert, update, and RPC call to Supabase.
- The backend creates one server-only Supabase client from `SUPABASE_URL` and
  `SUPABASE_SECRET_KEY`.
- `SUPABASE_SECRET_KEY` must use the new `sb_secret_...` key format, be stored
  only in the protected VPS environment, and never be committed, rendered into
  HTML/JavaScript, returned by an API, or written to logs. The legacy
  `service_role` JWT is not the production configuration target.
- Because the secret key has elevated access and bypasses RLS, every public and
  administrator authorization decision remains in Fastify. Supabase is not a
  substitute for admin authentication, CSRF protection, route validation, or
  rate limiting.

### Public redemption

- Serve a public page containing exactly two inputs: one CDK and one session.
- Accept one raw access-token JWT or one JSON session object using the aliases
  already supported by `gptk12.txt`: `accessToken`, `access_token`, or `at`.
- Reject JSON arrays, multiple tokens, multiple JSON lines, missing access
  tokens, malformed JWT payloads, missing email claims, and expired sessions.
- Normalize the submitted CDK, derive its server-side HMAC hash, and optionally
  perform a non-authoritative unused-code lookup before validating the session.
- Snapshot the current `invite_workspace_id` for the request. A later admin edit
  must not redirect an in-flight redemption.
- Validate the session remotely against ChatGPT and obtain its normalized email
  before attempting to consume the CDK.
- After successful session validation, call one PostgreSQL function through
  Supabase `rpc()` to atomically change the matching CDK from `unused` to
  `used`, storing the normalized email, database-generated use time, initial
  result, and workspace-ID snapshot.
- The RPC is the sole authority for consumption. A preliminary lookup must not
  be treated as a lock or proof that the code can still be used.
- Missing, already-used, and concurrent-loser codes return the same sanitized
  invalid-or-used response. At most one request can claim a CDK.
- Invalid or expired sessions must not consume an otherwise unused CDK.
- Once the RPC marks a CDK `used`, invite, accept, Playwright, network,
  persistence, client-disconnect, and process failures must never return it to
  `unused`.
- Return a final Vietnamese success or error response. Do not report a merely
  queued request as final success.
- Show a concise notice before submission that a successfully validated session
  permanently uses the CDK even when a later invite or accept step fails.

### Join and existing Playwright acceptance

- Port only the candidate-side joining behavior required from `gptk12.txt`; do
  not run the userscript or depend on Tampermonkey, browser cookies,
  localStorage, reloads, or a browser-side CORS bypass.
- Use the request's workspace-ID snapshot for candidate-side
  `invites/request`, supplementary `invites/accept`, and membership checks.
- If candidate-side calls do not already confirm membership, submit only the
  validated email to the existing sequential Playwright acceptance flow and
  await the result for that email.
- Do not pass the ChatGPT session, access token, Supabase credential, CDK
  plaintext, CDK hash, or workspace ID into a Playwright queue job.
- Do not add any feature that changes the Playwright workspace, detects its
  workspace UUID, compares it with `invite_workspace_id`, or synchronizes it
  automatically. The operator is responsible for opening Playwright in the
  corresponding workspace.
- Do not change the existing `WorkspacePage.runAcceptFlow(page, emails)`
  workspace contract for this feature.
- Preserve sequential access to the single Playwright page. A minimal
  email-only completion promise may be added so a public redemption can await
  its own result.
- Keep existing webhook calls asynchronous with the same normalization,
  authentication, queue coalescing, Telegram notifications, daily JSON history,
  and exact `202` response. The webhook must not read or depend on the new
  Supabase setting.

### Supabase persistence

- Use one singleton `app_settings` row. Its only administrator-editable business
  value is nullable `invite_workspace_id`; technical singleton and timestamp
  columns are allowed.
- Use a `cdks` table containing an immutable CDK hash, `unused|used` status,
  normalized email, database-generated use time, safe result, and the workspace
  ID used by that redemption. Technical `id` and `created_at` columns are
  allowed for stable history and pagination.
- CDK status has exactly two values: `unused` and `used`. Success, failure, and
  processing information belongs in `result`, not in additional status values.
- A newly claimed row has `status='used'` and `result='processing'`. A terminal
  result may replace `processing` once, but no result update may alter status,
  code hash, email, use time, or workspace snapshot.
- Allowed terminal result codes are `accepted`, `already_member`,
  `join_rejected`, `accept_not_found`, `worker_unavailable`,
  `upstream_timeout`, `internal_error`, and `service_interrupted`.
- A service restart may change leftover `used/processing` rows to
  `service_interrupted`; it must never make them reusable.
- Enable RLS on both tables without browser-facing policies. Revoke table and
  function access from `anon` and `authenticated`, and restrict the consume
  function to the backend role used by the secret key.
- Apply a database guard that prevents changing a CDK hash, reversing
  `used -> unused`, deleting application rows through the backend role, or
  overwriting a terminal result.

### CDK generation

- Generate non-expiring CDKs with a cryptographically secure random generator.
- Use four groups of four unambiguous uppercase characters:
  `XXXX-XXXX-XXXX-XXXX`.
- Treat CDK input case-insensitively and ignore surrounding ASCII whitespace
  and hyphens during normalization.
- Hash the normalized CDK in Node with HMAC-SHA-256 and a dedicated
  `CDK_HASH_SECRET`. Never reuse `SUPABASE_SECRET_KEY` as the HMAC secret.
- Send only the HMAC hash to Supabase. Do not store the complete code or a
  plaintext hint in any database column.
- Return newly generated plaintext CDKs to the authenticated administrator only
  after their hashes have been inserted successfully. Display them exactly once
  with `Cache-Control: no-store`; they cannot be retrieved later.
- CDKs do not expire and cannot be revoked, reactivated, refunded, or deleted
  through the application.

### Administration

- Authenticate the administrator with a dedicated password stored in the VPS
  environment.
- Use an HTTPS-only, HTTP-only, signed, same-site admin cookie with a bounded
  lifetime. A service restart may invalidate active admin sessions.
- Require CSRF protection and exact-origin validation for every authenticated
  state-changing endpoint.
- The dashboard has only these business capabilities:
  - view and update `invite_workspace_id`;
  - create a requested batch of 1 to 100 CDKs and show the plaintext batch once;
  - view paginated CDK history with row ID, created time, status, email, used
    time, safe result, and workspace ID.
- Login, logout, pagination, and copying a newly created batch are supporting UI
  mechanics, not additional business capabilities.
- Do not expose `code_hash`, CDK plaintext from earlier batches, raw sessions,
  access tokens, Supabase credentials, or raw upstream responses.
- Display this warning beside the workspace setting and CDK creation controls:
  **“Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK.”**

### Session privacy, logging, and API security

- Keep the raw session and access token only in request-local RAM while the
  redemption is active. Clear application references in a `finally` block.
- JavaScript strings cannot be securely zeroized; the guarantee is no durable
  persistence and best-effort release for garbage collection, not physical RAM
  overwriting.
- Never place session material in Supabase arguments, tables, queue jobs,
  history, Telegram messages, logs, error objects, screenshots, URLs, analytics,
  cookies, localStorage, sessionStorage, or API responses.
- Disable Fastify request-body logging and recursively redact session, token,
  authorization, API-key, and Supabase-secret field names as defense in depth.
- Apply strict JSON schemas, a 64 KiB redemption body limit, same-origin checks
  for admin mutations, security headers, `Cache-Control: no-store`, and per-IP
  rate limits for redemption and admin login.
- Return stable public error codes and Vietnamese messages. Never return or log
  raw ChatGPT or Supabase response bodies.

### Compatibility and deployment

- Keep one Fastify process and one systemd service on the existing VPS.
- Keep `/health`, the configured webhook route, Telegram bot commands,
  Playwright persistent profile, existing invite JSON history, and session
  expiry behavior operational.
- Keep Fastify bound to loopback and expose only the approved public, admin,
  webhook, and health routes through the existing Caddy HTTPS site.
- Use Node.js 24 LTS for this feature deployment; this active task supersedes
  the older VPS task's Node.js 20 baseline without modifying that separate
  requirement document.
- Apply and verify the Supabase schema/function migration before deploying code
  that can generate CDKs.

## Non-Goals

- Browser-side Supabase access or Supabase Auth for redeemers/administrators.
- Multiple sessions per CDK or one request.
- Multiple target workspaces, workspace selection by redeemers, or per-CDK
  workspace selection at issuance time.
- CDK expiry, revocation, deletion, reactivation, refund, or automatic reissue.
- Persisting sessions for retry after restart.
- Replacing the existing Playwright acceptance implementation.
- Changing, detecting, validating, or synchronizing the Playwright workspace.
- Moving existing webhook, Telegram, browser-profile, or invite-history data
  into Supabase.
- Keeping the Tampermonkey UI, token-export features, account-switch storage, or
  K12-name matching from `gptk12.txt`.

## Acceptance Criteria

- [ ] Public and admin pages communicate only with same-origin Fastify APIs and
      contain no Supabase URL, key, client initialization, or direct query.
- [ ] The backend accepts only `SUPABASE_SECRET_KEY` in the new `sb_secret_...`
      format for production Supabase access, and secret sentinels never appear
      in HTML, JavaScript, JSON responses, or logs.
- [ ] `app_settings` exposes exactly one editable business value,
      `invite_workspace_id`, and the admin UI exposes no other setting.
- [ ] Supabase stores only CDK hashes. A generated plaintext code is returned
      once and cannot be recovered from history or database-owned text fields.
- [ ] An invalid or expired session leaves an otherwise valid CDK `unused`.
- [ ] Two concurrent RPC claims for one unused CDK produce exactly one `used`
      row and one loser; only the winner proceeds to invite/accept work.
- [ ] The winning RPC stores normalized email, database use time,
      `result='processing'`, and the request's workspace-ID snapshot.
- [ ] Every failure after a successful claim leaves status `used`; a terminal
      result or `service_interrupted` describes the outcome without making the
      code reusable.
- [ ] Database permissions and guards reject browser roles, hash changes,
      `used -> unused`, deletion through the application role, and terminal
      result overwrite.
- [ ] The administrator can only update Invite Workspace ID, create 1-100 CDKs,
      view history, and use supporting login/logout/copy/pagination controls.
- [ ] The admin page renders the exact Playwright workspace warning, and no
      route or worker code switches, verifies, or synchronizes Playwright's
      workspace.
- [ ] The raw session/token sentinel is absent from Supabase columns, queue
      jobs, JSON history, Telegram, logs, screenshots, responses, and rendered
      pages after both success and failure tests.
- [ ] Existing webhook normalization/authentication, exact `202` response,
      queue serialization, Telegram reporting, `/check`, `/clean`, `/health`,
      persistent browser profile, and session-expired behavior pass regression
      tests without depending on Supabase settings.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`
      pass, and the guarded VPS smoke test proves one code remains `used` after
      both successful use and an intentional post-claim failure.

## References

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase JavaScript RPC](https://supabase.com/docs/reference/javascript/rpc)
- [Supabase data security](https://supabase.com/docs/guides/database/secure-data)

`gptk12.txt` remains research input for candidate-side ChatGPT calls and is not
served to browsers or deployed as application code.
