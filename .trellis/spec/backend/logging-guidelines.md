# Logging Guidelines

> How logging is done in this project.

---

## Overview

<!--
Document your project's logging conventions here.

Questions to answer:
- What logging library do you use?
- What are the log levels and when to use each?
- What should be logged?
- What should NOT be logged (PII, secrets)?
-->

The service uses the project-local `JsonLogger` in `src/logger.ts`. It writes one
JSON object per line to stdout (and optionally to the configured log file), so
systemd/journald can collect the same event shape as local logs.

---

## Log Levels

<!-- When to use each level: debug, info, warn, error -->

- `debug`: development diagnostics that are safe to omit in production.
- `info`: normal lifecycle events such as accepted webhooks and queue changes.
- `warn`: recoverable upstream or operational anomalies.
- `error`: failed operations that need investigation or a safe recovery path.

---

## Structured Logging

<!-- Log format, required fields -->

Use `logger.<level>(message, metadata)` and keep metadata JSON-serializable.
Child loggers add stable bindings without duplicating them at every call site.
`redactSensitive` runs before serialization.

---

## What to Log

<!-- Important events to log -->

- Log counts, safe identifiers, endpoint paths, HTTP statuses, and queue state.
- For ChatGPT upstream failures, log only the request path and HTTP status; the
  join client must never include the bearer token in diagnostics.

---

## What NOT to Log

<!-- Sensitive data, PII, secrets -->

Never log access tokens, session JSON, authorization headers, passwords, API
keys, Supabase secrets, refresh tokens, or full user credentials. The logger
redacts known sensitive keys and JWT/Bearer patterns, but call sites must still
avoid putting secrets into messages or metadata.
