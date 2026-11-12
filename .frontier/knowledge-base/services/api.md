---
title: API service (apps/api)
type: service
covers: ["apps/api/src/**", "apps/api/test/db-proxy.ts", "apps/api/test/outage.ts", "tooling/check-exposure.ts"]
status: current
last_reviewed: 2026-11-12
related: ["[[index]]"]
tags: [api, fastify, browser-safety, resilience]
---

# API service (apps/api)

**Purpose.** The personal todo app's REST API (Fastify 5, TypeScript). Reachable from this machine only; no authentication (ADR Exception A), so the network and browser-safety layer is the compensating control.

**Entry points.** `apps/api/src/index.ts` (process wiring), `src/fatal.ts` (`runMain`, fatal handlers), `src/start.ts` (`start`, `LISTEN_HOST` constant, `EADDRINUSE` to `StartupError`), `src/app.ts` (`buildApp`: opens no socket), `src/config.ts` (`loadConfig`).

**Request pipeline.** `src/security.ts` `registerSecurity` registers, as skip-override plugins in a fixed order: helmet, `Cache-Control: no-store`, Host check, Origin check, plain-`OPTIONS` guard, CORS. Rules live in pure `checkHost` and `checkOrigin`; allowlists derive from `API_PORT` and `WEB_PORT` only. A malformed URL is raised by Fastify before routing, so no hook runs for it: `FRAMEWORK_ERROR_HEADERS` is set in the `frameworkErrors` handler in `src/app.ts`, and that path skips the Host and Origin checks (accepted).

**Errors.** `src/errors.ts`: `AppError`, `sendError`, `STATUS_BY_CODE` and `MESSAGE_BY_CODE` typed over the closed list in `packages/shared/src/errors.ts`, and the ordered `ERROR_RULES` behind `mapError` (add rules before the fallback). Order: `AppError`, unknown route (404), bad URL (404), `malformed_json` (matched by Fastify code, never by message), database unavailable (503), the interim client-error rule (500, code only; ticket 4 replaces it with 413 and 415), generic 500. Both `setErrorHandler` and `frameworkErrors` call `replyWithError`, which is total: if mapping throws, a constant 500 body goes out. Any error on a request that matched no route is 404 `route_not_found`.

**Database failures.** `src/db/failure.ts` `classifyDatabaseFailure` answers 503 for SQLSTATE `57P01`, `57P03`, `57014` and class `08`, errno `ECONNREFUSED` and `ECONNRESET`, and four exact pg 8.23.1 texts that carry no `code`: `timeout exceeded when trying to connect` (log code `POOL_TIMEOUT`), `Connection terminated due to connection timeout` (`CONNECT_TIMEOUT`), `Query read timeout` (`QUERY_TIMEOUT`), `Connection terminated unexpectedly` (`CONNECTION_LOST`). The capitalised log codes are synthetic, not driver codes. It looks through `cause` (five errors, which also stops a cycle), applies the text matches only to an `Error` with no string `code` and no `severity`, skips an error with a 4xx `statusCode`, and never reads `AggregateError.errors`. Any other database error is a 500. The pool values (`src/db/pool.ts`) equal ADR Decision 11 and the API caches no "down" state and retries nothing, so recovery needs no code. The `/health` query is a raw `pool.query`, so the Drizzle wrapper (`DrizzleQueryError`: message `Failed query: ...`, driver error in `cause`) is covered only by a synthetic test. Follow-up for ticket 4: check the first real Drizzle error against the classifier, and make the generic 500 rule read the code through `cause` (it reads the outer error only, so a wrapped `23505` would log `unknown`).

**Logging.** `src/request-log.ts`: `buildRequestLine` is the only builder; one line per request, written by an `onResponse` hook and by `frameworkErrors` (Fastify's own error log stays off through `disableRequestLogging`). 4xx lines carry `err.code` only. 5xx lines are level `error` with `err: { code, message, stack }`: the code is the runtime or driver code or a synthetic one, the message is the fixed contract message for the response code (never the driver message, which carries connection details and, from Drizzle, SQL and parameters), and the stack is `safeStack` in `src/logger.ts`: frame locations only, at most 6 frames and 1500 characters, and no stack at all when the message cannot be cut out cleanly. The pool, shutdown and cleanup lines use `describeError(error, key)`, a code plus one of three fixed texts. Path has no query and is capped at 200 code points. `src/logger.ts` reduces a real `Error` under `err` to its code, and `errorCode` never throws.

**Owns data.** The `todos` table through `src/db/` (migrations in `apps/api/drizzle/`).

**Exposure check.** `tooling/check-exposure.ts` (`pnpm check:exposure`): probes non-internal addresses and `::1` on `API_PORT` and `DB_PORT`; exit codes 0 to 5 are documented in the file header and the README Security section.

**Gotchas.** `light-my-request` sends Host `localhost:80`, so tests use `injectLocal` (`apps/api/test/request.ts`). Tests force `API_PORT` 3001 and `WEB_PORT` 3000 (`test/db-setup.ts`); real-socket tests use `freePort()`. Helmet writes the CSP directives joined by `;` with no space. Node trims outer whitespace from Host before the check, and keeps only the first of two `Host` lines in `request.headers` (the hook reads `rawHeaders`).

**Outage tests.** `apps/api/test/db-proxy.ts` is a loopback-only TCP proxy (`cut`, `blackhole`, `restore`, same port) put between the app and the test database, so no Docker command is needed; `test/outage.ts` starts the real app behind it (`startTestServer(routes, { dbPort })`) and polls `/health` for recovery. `outage.test.ts` proves 503, survival and recovery on one app and pool, and runs the four driver texts against the real pg driver, so a driver upgrade that rewords one fails the build. `startup-outage.test.ts` covers the startup wait. A real-process test spawns `src/index.ts` with `test/child.ts` (own process group, minimal environment, bounded output).
