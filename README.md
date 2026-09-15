# Switchyard — Telegram relay operations console

Watches a set of **master** Telegram channels and relays every new post to any number of
**receiver** channels in near real time — with per-route keyword filters, find-and-replace,
link stripping, headers/footers, delays, weekly schedules, edit/delete sync, failure alerts,
bot fan-out for scale, and a live web dashboard to run it all without restarts.

## Layout

```
apps/
├── web/       Next.js 16 dashboard (Supabase auth, realtime, worker admin proxy)
└── worker/    Always-on relay: GramJS (user accounts) + grammY (bots) + simulator
packages/
└── core/      Pure rules engine: filters, entity-aware transforms, scheduling (100% shared)
supabase/
└── migrations/  Schema, RLS, invite-only auth, cron watchdog & retention
```

## Prerequisites

- Node ≥ 22, pnpm 9
- A Supabase project (schema in `supabase/migrations` is already applied to the hosted one)
- Docker — only for local development / e2e (local Supabase stack)

## Setup

```bash
pnpm install
cp .env.example apps/web/.env.local     # fill in the dashboard vars
cp .env.example apps/worker/.env        # fill in the worker vars
```

Key secrets (never committed):

| Variable | Where | What |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | worker | Supabase → Settings → API |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | worker | https://my.telegram.org → API development tools |
| `SESSION_ENCRYPTION_KEY` | worker | 32+ random chars; encrypts Telegram sessions at rest |
| `WORKER_API_TOKEN` | both | shared bearer token between dashboard proxy and worker |

## Run

```bash
pnpm --filter @pierre/worker dev   # relay worker (SIMULATE=1 works without Telegram creds)
pnpm --filter web dev              # dashboard on http://localhost:3000
```

Sign in with an invited email (invite-only — enforced in the database), connect the Telegram
user account and bot from **Accounts**, add channels, wire routes. Everything applies live.

## Test

```bash
pnpm test                          # unit tests (rules engine + relay engine)
pnpm dlx supabase start            # once: local stack for e2e
pnpm --filter web test:e2e         # full end-to-end against simulated Telegram
```

## Operational notes

- **Protected masters** ("Restrict saving content") cannot be relayed by any tool; the app
  detects and flags them instead of attempting workarounds that violate Telegram's ToS.
- A database-side watchdog (pg_cron) opens a `worker_offline` incident if heartbeats stop —
  it fires even when the worker itself is dead.
- The queue lives in Postgres: delays, schedules and retries survive restarts, and the unique
  `(route, message, kind)` constraint guarantees nothing is ever posted twice.

## Branches

- `dev` — integration branch (default)
- `prod` — production releases
