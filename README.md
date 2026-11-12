# agent-built-todo-app

A personal todo app that runs on your own machine only. This page covers the database and API; the web app and the other checks are added by later tickets.

## Prerequisites

- Node 24 (see `.nvmrc`), pnpm 11.6.0 and Docker.

## Setup

Do these in order. Set the password before the first `docker compose up`: Postgres applies `DB_PASSWORD` only when it creates a new data volume.

1. Copy the settings file and keep it private: `cp .env.example .env` then `chmod 600 .env`.
2. Generate a password with `openssl rand -hex 24` and put it in `.env` as `DB_PASSWORD` (at least 16 characters, not `change-me`). Keep `DB_HOST=127.0.0.1`; it is preferred over `localhost`, which can reach a different Postgres on this machine.
3. Start the database: `docker compose up -d --wait`.
4. Install dependencies: `pnpm install`.
5. Start the API: `pnpm --filter @todo/api dev`. It creates the todos table by itself.
6. Check it: `curl http://127.0.0.1:3001/health` answers `{"status":"ok"}`. Press Ctrl-C to stop it cleanly.

The API URL is `http://127.0.0.1:3001` (the port is `API_PORT` in `.env`). Use that literal address, not `localhost`, which can resolve to a different program on this machine.

The API logs one JSON object per line. Pipe them through `| jq` if you want them easier to read (optional).

Docker Compose also reads `.env`, and the password is visible to your own user through `docker inspect`. The API listens on `127.0.0.1` only and has no login, so do not change that.

## Your data

- `docker compose down` stops the database and keeps your todos.
- `docker compose down -v` deletes the data volume and all your todos.

## Security

- **This app is for this machine only and has no login.** The API listens on `127.0.0.1` (a fixed value in the code, not a setting) and the database port is published on `127.0.0.1` only. Anyone who can reach the API can read and change every todo, so do not change a bind address, publish a port without the `127.0.0.1:` prefix in `docker-compose.yml`, or put a proxy or tunnel in front of it.
- **A wrong host name gets 403 `host_not_allowed`.** The API answers only when the `Host` header is `localhost` or `127.0.0.1` followed by the API port. This stops a web page from reaching the API under a host name it controls (DNS rebinding). A request such as `curl -H 'Host: example.com' http://127.0.0.1:3001/health` is refused on purpose, and so is a second `Host` line or a request target that starts with `http://`.
- **A foreign `Origin` gets 403 `origin_not_allowed`.** A browser page may call the API only from `http://localhost` or `http://127.0.0.1` on the web port (`WEB_PORT`). Those two origins, and no others, get cross-origin access. Both rules also apply to unknown routes and to the browser's preflight request.
- **A request with no `Origin` is allowed on purpose.** Tools such as `curl` and scripts never send one, and browsers always send one on a cross-origin call, so the missing header cannot be used by another web page.
- **Every response** the API routes carries security headers (a content-security policy of `default-src 'none'` and `frame-ancestors 'none'`, among others) and `Cache-Control: no-store`, and each request writes one log line with no query, headers or todo text. A request that Node rejects before the API sees it (for example HTTP/1.1 with no `Host` line) gets Node's bare 400 and no log line.
- **Check that nothing else can reach the stack.** With the database and the API running, `pnpm check:exposure` tries every non-internal IPv4 and IPv6 address of this machine and `::1` on `API_PORT` and `DB_PORT`, and expects each to refuse the connection. It prints one line per probe and exits 0 only when all were refused: 1 means a port is exposed, 2 means a probe timed out (inconclusive, not a pass), 3 means this machine has no LAN interface so nothing was verified (`--allow-unverified` accepts that case and still prints "not verified"), 4 means nothing is listening on `127.0.0.1` at a port (start the stack first).

## Troubleshooting

- **The API prints a variable name and a reason, then exits.** Fix that variable in `.env`; the message never shows the value. The rules: `DB_USER` and `DB_NAME` are lowercase letters, digits and underscores; `DB_PASSWORD` is at least 16 characters and not `change-me`; `DB_HOST` is `127.0.0.1` or `localhost`; the ports are whole numbers from 1 to 65535.
- **"database unreachable at host:port after 31 attempts".** The API tries once a second for 31 attempts, about 30 seconds when the database refuses connections (longer if a host never answers). Run `docker compose up -d` and start the API again.
- **503 `database_unavailable` while the API is running.** The API cannot reach the database (stopped, restarting or not answering). It stays up, answers 503 and logs one error line per failed request; nothing needs restarting. Run `docker compose up -d --wait` and the next request succeeds within 30 seconds, with no API restart. The error lines carry a safe code and fixed text only, never database or connection details: `ECONNREFUSED` (refused), `CONNECT_TIMEOUT`, `QUERY_TIMEOUT`, `POOL_TIMEOUT` (no answer in time) or `CONNECTION_LOST` (dropped mid-query). Any other database error answers 500 `internal_error`.
- **"the password ... does not match the one stored in the existing database volume".** `DB_PASSWORD` in `.env` differs from the one the volume was created with. Put the old password back to keep your todos, or run `docker compose down -v` (this deletes all todos) and start again.
- **"the database ... does not exist".** Check `DB_NAME` in `.env`. Postgres creates that database only when the volume is first created, so a new name needs `docker compose down -v` (this deletes all todos).
- **Port 5432 is already in use** (another Postgres on this machine). Set `DB_PORT` to a free port such as `5433` in `.env`, then run `docker compose up -d --wait` again. Compose and the API both read it.
- **"port ... is already in use" when starting the API.** Another program already listens on `API_PORT` (3001 by default). Stop it, or set `API_PORT` to a free port in `.env` and start the API again.
- **403 `host_not_allowed`.** The `Host` header is not `localhost` or `127.0.0.1` with the API port. Call `http://127.0.0.1:3001` (or whatever `API_PORT` says) and do not reach the API by another host name, through a proxy or through a tunnel.
- **403 `origin_not_allowed`.** The page making the call is not `http://localhost` or `http://127.0.0.1` on `WEB_PORT`. Open the web app from one of those two addresses; if you changed `WEB_PORT`, restart the API.
- **`pnpm check:exposure` exits 4 ("NOT RUNNING").** Nothing accepts connections on `127.0.0.1` at that port, so a refusal elsewhere would prove nothing. Run `docker compose up -d --wait`, start the API, and run it again. Exit 2 (inconclusive) means a probe timed out; it is never a pass, so look at the line that says which address and check the `lsof -nP -iTCP -sTCP:LISTEN` bind output by hand.
- **"`../../.env`: not found" when starting the API.** Create `.env` as in Setup.
- **Tests fail with "The test database is not usable".** The API tests need the database running (`docker compose up -d --wait`) and a root `.env`. They use a separate database called `todo_test`, never your own, and refuse to empty any database whose name does not end in `_test`. If another `pnpm test` is running, the second run fails with a message saying so; wait for the first to finish.
- **Two API processes started at the same moment can race on the very first migration.** Start one, then the other.
