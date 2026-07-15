# Error Handling

> How errors are handled in this project.

---

## Overview

<!--
Document your project's error handling conventions here.

Questions to answer:
- What error types do you define?
- How are errors propagated?
- How are errors logged?
- How are errors returned to clients?
-->

Domain failures use `DomainError` from `src/domain-error.ts`. Each error has a
stable machine-readable `code`, a Vietnamese server-facing `publicMessage`,
and an optional safe cause detail for diagnostics. API handlers return the code
and message as JSON; browser pages translate known codes into English copy.

---

## Error Types

<!-- Custom error classes/types -->

`DomainErrorCode` is the shared error taxonomy for validation, upstream,
worker, storage, and redemption failures. Do not use raw upstream response
bodies as public messages.

---

## Error Handling Patterns

<!-- Try-catch patterns, error propagation -->

Validate workspace/CDK/session inputs before claiming a CDK. Catch unknown
errors at the service boundary and convert them to `INTERNAL_ERROR`. For
ChatGPT requests, retry transient 429/5xx responses, log only path/status, and
include only the safe status reason in `DomainError.safeCauseCode`.

---

## API Error Responses

<!-- Standard error response format -->

Responses use `{ code, message }` for failures and add `ok`/result fields for
successful operations. The frontend must branch on `code`, not copy server
wording into user-facing text.

---

## Common Mistakes

<!-- Error handling mistakes your team has made -->

- Do not compare `chatgpt_account_id` decoded from a validated ChatGPT JWT
  with the root `id` from `/backend-api/me`: that endpoint returns a
  user-prefixed identifier from a different namespace. Use `/me` to prove the
  token is live and its email matches; retain the account ID from the JWT.
- Preserve the validation-before-claim order in CDK redemption. A session
  validation failure must never consume a CDK.
