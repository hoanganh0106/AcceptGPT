# CDK redeem feedback and web UI implementation plan

**Goal:** Make CDK redemption feedback correct and make the two existing server-rendered pages usable and responsive without changing their API contracts.

**Architecture:** Keep the single nonce-protected HTML document renderer. Extend its small inline client scripts for state, feedback, and DOM rendering; configure Fastify's existing rate limiter with a Vietnamese JSON error builder.

**Constraints:** Keep all browser calls same-origin; retain CSP nonce-only inline CSS/JS; do not introduce browser Supabase access, storage, external assets, or CDK/session disclosure.

### Task 1: Rate-limit contract

- [ ] Add a failing Fastify injection test for `/api/redeem` returning JSON `RATE_LIMITED` and Vietnamese `message` after the configured maximum.
- [ ] Run the focused server test and observe the default response fail the assertion.
- [ ] Configure `@fastify/rate-limit` with `errorResponseBuilder` while keeping existing route options.
- [ ] Re-run the focused server test and commit the server/test change.

### Task 2: Redeem feedback

- [ ] Add a failing rendered-page test for `data.ok` branching, success/error alert classes, and submit loading state.
- [ ] Run the focused page test and observe the missing markup/script assertions fail.
- [ ] Implement the nonce-safe redeem card styles and client result formatter; clear session before fetch as today.
- [ ] Re-run the focused page test and commit the page/test change.

### Task 3: Admin bootstrap and responsive dashboard

- [ ] Add failing rendered-page assertions for initial admin state load, explicit state-service failure copy, copy control, badges, empty state, and responsive table wrapper.
- [ ] Run the focused page test and observe the assertions fail.
- [ ] Implement the dashboard renderer/client helpers, loading state, copy interaction, status badges, and responsive styles.
- [ ] Re-run the focused page test; then run `npm run check` and commit the final task files plus source/tests.
