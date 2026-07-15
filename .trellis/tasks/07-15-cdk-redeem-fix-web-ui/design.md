# Design — CDK redeem feedback and web UI

## Scope

Keep the existing Fastify routes and `RedemptionResult` contract. The change is limited to server-side rate-limit response shaping and the nonce-protected HTML/CSS/JS returned by `src/web-pages.ts`.

## Redeem page

The submit handler clears the session field immediately, disables the submit button while the request is in flight, and chooses the rendered alert from `data.ok`. A successful `accepted` or `already_member` result uses a Vietnamese green success message containing the normalized email. An API failure uses its supplied `message`; network and malformed-response fallbacks use a Vietnamese error message. No session value is persisted or logged.

## Admin page

On first load, the page requests `/api/admin/state`. A 401 leaves the login card visible; an authenticated state response exposes the dashboard and renders workspace/history. A post-login state failure uses a distinct message saying authentication succeeded but the data service is temporarily unavailable. The dashboard adds loading states, copied-CDK feedback, status/result badges, an empty history row, and a horizontally scrollable history container on small screens.

## Server

The Fastify rate-limit plugin gets an `errorResponseBuilder` returning only `{ code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.' }`. This applies to both configured protected routes without altering their rate-limit counts or API success/error contracts.

## Verification

Tests assert rendered-page contracts for success/error/admin bootstrap and Fastify injection asserts Vietnamese 429 JSON. Existing security sentinel assertions remain. `npm run check` is the final local gate.
