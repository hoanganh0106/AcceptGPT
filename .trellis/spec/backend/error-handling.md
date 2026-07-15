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

(To be filled by the team)

---

## Error Types

<!-- Custom error classes/types -->

(To be filled by the team)

---

## Error Handling Patterns

<!-- Try-catch patterns, error propagation -->

(To be filled by the team)

---

## API Error Responses

<!-- Standard error response format -->

(To be filled by the team)

---

## Common Mistakes

<!-- Error handling mistakes your team has made -->

- Do not compare `chatgpt_account_id` decoded from a validated ChatGPT JWT
  with the root `id` from `/backend-api/me`: that endpoint returns a
  user-prefixed identifier from a different namespace. Use `/me` to prove the
  token is live and its email matches; retain the account ID from the JWT.
- Preserve the validation-before-claim order in CDK redemption. A session
  validation failure must never consume a CDK.
