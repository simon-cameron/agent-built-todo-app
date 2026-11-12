---
title: API service (apps/api)
type: service
covers: ["apps/api/src/**", "tooling/check-exposure.ts"]
status: current
last_reviewed: 2026-11-12
related: ["[[index]]"]
tags: [api, fastify, browser-safety]
---

# API service (apps/api)

**Purpose.** The personal todo app's REST API (Fastify 5, TypeScript). Reachable from this machine only; no authentication (ADR Exception A), so the network and browser-safety layer is the compensating control.

**Entry points.** `apps/api/src/index.ts` (process wiring), `src/fatal.ts` (`runMain`, fatal handlers), `src/start.ts` (`start`, `LISTEN_HOST` constant, `EADDRINUSE` to `StartupError`), `src/app.ts` (`buildApp`: opens no socket), `src/config.ts` (`loadConfig`).

**Request pipeline.** `src/security.ts` `registerSecurity` registers, as skip-override plugins in a fixed order: helmet, `Cache-Control: no-store`, Host check, Origin check, plain-`OPTIONS` guard, CORS. Rules live in pure `checkHost` and `checkOrigin`; allowlists derive from `API_PORT` and `WEB_PORT` only. A malformed URL is raised by Fastify before routing, so no hook runs for it: `FRAMEWORK_ERROR_HEADERS` is set in the `frameworkErrors` handler in `src/app.ts`, and that path skips the Host and Origin checks (accepted).

**Errors.** `src/errors.ts`: `AppError`, `sendError`, `STATUS_BY_CODE` and `MESSAGE_BY_CODE` typed over the closed list in `packages/shared/src/errors.ts`, and the ordered `ERROR_RULES` behind `mapError` (add rules before the fallback). Both `setErrorHandler` and `frameworkErrors` call `replyWithError`. Any error on a request that matched no route is 404 `route_not_found`.

**Logging.** `src/request-log.ts`: `buildRequestLine` is the only builder; one line per request, written by an `onResponse` hook and by `frameworkErrors`. 4xx lines carry `err.code` only; 5xx lines carry the runtime code and a fixed message. Path has no query and is capped at 200 code points. `src/logger.ts` reduces a real `Error` under `err` to its code.

**Owns data.** The `todos` table through `src/db/` (migrations in `apps/api/drizzle/`).

**Exposure check.** `tooling/check-exposure.ts` (`pnpm check:exposure`): probes non-internal addresses and `::1` on `API_PORT` and `DB_PORT`; exit codes 0 to 5 are documented in the file header and the README Security section.

**Gotchas.** `light-my-request` sends Host `localhost:80`, so tests use `injectLocal` (`apps/api/test/request.ts`). Tests force `API_PORT` 3001 and `WEB_PORT` 3000 (`test/db-setup.ts`); real-socket tests use `freePort()`. Helmet writes the CSP directives joined by `;` with no space. Node trims outer whitespace from Host before the check, and keeps only the first of two `Host` lines in `request.headers` (the hook reads `rawHeaders`).
