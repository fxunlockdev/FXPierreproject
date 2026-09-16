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
└── migrations/  Schema, RLS, private spaces, cron watchdog & retention
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

Create an account on the login page — you land in your own blank space. Connect a bot from
**Accounts**, add channels, wire routes. Everything applies live.

## Private spaces

Every account works inside a **space**: its bots, channels, routes, logs, alerts and settings
are visible only to that space's members. Isolation is enforced by row-level security in the
database and by the worker, which scopes every relay decision and admin call to one space.

- **Sign-up** creates a blank space owned by the new user.
- **Teammates** join through a one-time invite code (Settings → Team, valid 7 days) as
  *viewer* (read-only) or *admin*. Existing users enter a code under “Join another space”.
- **Platform admin** (`/admin`) lists spaces with counts only — never their content — can
  disable a space (relaying stops, members lose access) and can close sign-ups, after which
  only invite codes create accounts. Grant it once per operator:

  ```sql
  insert into platform_admins select id from auth.users where email = 'you@example.com';
  ```

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
  `(route, message, kind)` constraint guarantees nothing is ever posted twice. If the worker
  is killed mid-send, the affected row is parked as **failed / unconfirmed** rather than
  retried automatically — a delivered post must never be guessed at.
- **Run exactly one worker instance.** The queue claim is multi-instance-safe, but send
  pacing is in-process; two instances would drive a sender account at twice its rate.

## Production checklist (before real traffic)

1. **Supabase Auth → keep email sign-ups enabled**; open/close registration from `/admin`
   instead (enforced by a database trigger, so the auth API can't bypass it). Disable any
   other auth providers you don't use.
2. **"Confirm email"** stops people registering addresses they don't own. Turn it on only
   with a custom SMTP sender configured — Supabase's built-in mailer is heavily rate-limited
   and would block real sign-ups. Access to a space never depends on the email address
   (only on membership and invite codes), so leaving it off cannot leak a space.
3. Set a strong `SESSION_ENCRYPTION_KEY` and `WORKER_API_TOKEN`; never reuse dev values.
4. Keep the worker's admin API (`:8788`) unreachable from the public internet — only the
   dashboard's server-side proxy needs it.
5. Make the GitHub repo private (org admin) and protect the `prod` branch.

## Branches

- `dev` — integration branch (default)
- `prod` — production releases
