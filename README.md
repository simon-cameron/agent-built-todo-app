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

The API logs one JSON object per line. Pipe them through `| jq` if you want them easier to read (optional).

Docker Compose also reads `.env`, and the password is visible to your own user through `docker inspect`. The API listens on `127.0.0.1` only and has no login, so do not change that.

## Your data

- `docker compose down` stops the database and keeps your todos.
- `docker compose down -v` deletes the data volume and all your todos.

## Troubleshooting

- **The API prints a variable name and a reason, then exits.** Fix that variable in `.env`; the message never shows the value. The rules: `DB_USER` and `DB_NAME` are lowercase letters, digits and underscores; `DB_PASSWORD` is at least 16 characters and not `change-me`; `DB_HOST` is `127.0.0.1` or `localhost`; the ports are whole numbers from 1 to 65535.
- **"database unreachable at host:port after 31 attempts".** The API tries once a second for 31 attempts, about 30 seconds when the database refuses connections (longer if a host never answers). Run `docker compose up -d` and start the API again.
- **"the password ... does not match the one stored in the existing database volume".** `DB_PASSWORD` in `.env` differs from the one the volume was created with. Put the old password back to keep your todos, or run `docker compose down -v` (this deletes all todos) and start again.
- **"the database ... does not exist".** Check `DB_NAME` in `.env`. Postgres creates that database only when the volume is first created, so a new name needs `docker compose down -v` (this deletes all todos).
- **Port 5432 is already in use** (another Postgres on this machine). Set `DB_PORT` to a free port such as `5433` in `.env`, then run `docker compose up -d --wait` again. Compose and the API both read it.
- **"`../../.env`: not found" when starting the API.** Create `.env` as in Setup.
- **Tests fail with "The test database is not usable".** The API tests need the database running (`docker compose up -d --wait`) and a root `.env`. They use a separate database called `todo_test`, never your own, and refuse to empty any database whose name does not end in `_test`. If another `pnpm test` is running, the second run fails with a message saying so; wait for the first to finish.
- **Two API processes started at the same moment can race on the very first migration.** Start one, then the other.
