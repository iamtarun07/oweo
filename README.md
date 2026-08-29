# Oweo — backend

> *"Who owes whom?"* — an expense-sharing API. Split a bill, track who owes what,
> settle up.

Express + TypeScript REST API with a complete authentication system: sessions
with rotating refresh tokens, email verification, and password reset by one-time
code.

**Status:** authentication complete and tested (37 tests). Groups, expenses and
balances are next.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ / TypeScript (`strict`) | |
| Framework | Express 5 | Native async error handling |
| Database | PostgreSQL 16 (Docker) | |
| ORM | Prisma 7 | Typed client, real migrations |
| Validation | zod | One schema is both the runtime check and the TypeScript type |
| Passwords | argon2id | Memory-hard, current OWASP recommendation |
| Tokens | JWT (access) + opaque random (refresh) | Stateless where it is hot, revocable where it matters |
| Logging | pino | Structured JSON, secrets redacted |
| Email | Resend, or a console driver | No provider account needed in development |
| Tests | Vitest + Supertest | |

---

## Quick start

Requires Node 20+ and Docker Desktop.

```bash
git clone <this-repo>
cd oweo/backend

npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Generate two different secrets and paste them into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then:

```bash
docker compose up -d          # Postgres on port 5433
npx prisma migrate dev        # create the tables
npm run dev                   # http://localhost:4000
```

Check it:

```bash
curl http://localhost:4000/health
# {"status":"ok","uptime":1.2,"database":"up"}
```

> On Windows PowerShell use `curl.exe` — plain `curl` is an alias for
> `Invoke-WebRequest` and takes different flags.

---

## Environment

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `4000` | |
| `DATABASE_URL` | `postgresql://oweo:oweo@localhost:5433/oweo_dev?schema=public` | |
| `ACCESS_TOKEN_SECRET` | 32+ random bytes | Must differ from the refresh secret |
| `REFRESH_TOKEN_SECRET` | 32+ random bytes | |
| `ACCESS_TOKEN_TTL` | `15m` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `APP_BASE_URL` | `http://localhost:4000` | Used in verification links |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. Never `*` |
| `MAIL_DRIVER` | `console` | `console` prints to the terminal; `resend` really sends |
| `MAIL_FROM` | `Oweo <onboarding@resend.dev>` | |
| `RESEND_API_KEY` | | Required only when `MAIL_DRIVER=resend` |
| `LOG_LEVEL` | `debug` | |

Everything is validated with zod at boot — a missing or malformed value stops
the process immediately with a readable message, instead of failing later at
runtime.

---

## API

Base path `/api/v1`. Success responses are `{ "data": ... }`, failures are
`{ "error": { code, message, details?, requestId } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | — | Create an account, returns both tokens |
| `POST` | `/auth/login` | — | Returns both tokens |
| `GET` | `/auth/me` | Bearer | Current user |
| `POST` | `/auth/refresh` | — | Exchange a refresh token for a new pair |
| `POST` | `/auth/logout` | Bearer | Revoke this device's session (`204`) |
| `POST` | `/auth/verify-email` | — | Consume the emailed token |
| `POST` | `/auth/verify-email/resend` | Bearer | New verification email (rate limited) |
| `POST` | `/auth/forgot-password` | — | Email a 6-digit code |
| `POST` | `/auth/reset-password` | — | Verify the code and set a new password |
| `GET` | `/health` | — | Liveness plus a database check |

Example:

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Aarav","lastName":"Sharma","email":"aarav@example.com","password":"correct-horse-battery"}'
```

```jsonc
{ "data": {
    "accessToken":  "eyJhbGciOiJIUzI1NiIs...",   // JWT, 15 minutes
    "refreshToken": "nuR4gsX_6Jgjx30R1ILA...",   // opaque, 30 days
    "user": { "id": "6de3f3f4-...", "firstName": "Aarav", "lastName": "Sharma",
              "email": "aarav@example.com", "emailVerified": false,
              "friendCode": "XK8MA95" } } }
```

---

## Security design

A few decisions worth calling out, because they are the parts that are easy to
get wrong:

**Passwords** — argon2id with explicit parameters (19 MiB memory, time cost 2),
not library defaults. Never trimmed, so a trailing space stays part of the
password. Registration rejects anything in a 10,000-entry common-password list.

**Two tokens, two jobs** — a 15-minute JWT for every request (stateless, never
stored) and a 30-day opaque refresh token stored only as a SHA-256 hash. A
database leak exposes no usable session.

**Refresh rotation with reuse detection** — every refresh issues a new token and
retires the old one. Tokens from one login share a family id. Presenting an
already-rotated token means a copy exists somewhere it should not, so the entire
family is revoked. Stolen refresh tokens become a detectable event instead of
silent 30-day access. Concurrent refreshes are resolved by a conditional update
(`where: { rotatedAt: null }`) inside a transaction, so the database arbitrates
rather than application code.

**No account enumeration** — login answers identically for an unknown email and
a wrong password, including timing: the unknown-email path still performs a full
argon2 verification against a dummy hash. `/forgot-password` returns the same
`200` for verified, unverified, rate-limited and unknown addresses.

**Reset codes** — six digits is only a million combinations, so it is safe only
because three limits apply together: five attempts, ten-minute expiry, and three
requests per hour. Codes are hashed at rest and always looked up scoped to the
user. Completing a reset revokes every session on every device.

**Derived state, not stored state** — there is no `AccountStatus` column. Locked
and verified are computed from two timestamps, so no row can drift out of date
and no cleanup job is needed.

---

## Project layout

```
backend/
├── data/                    common-password list
├── prisma/                  schema + migrations
└── src/
    ├── app.ts               builds the Express app (no listen)
    ├── server.ts            listen + graceful shutdown
    ├── infrastructure/      env, database client, email drivers
    ├── modules/auth/        routes → controller → service → repository
    └── shared/              crypto, errors, middleware, validation, logger
```

One feature per folder in `modules/`, with the same six files each. Anything two
features would share moves to `shared/`.

Four layers, one job each: **controllers know HTTP but no rules, services know
rules but no HTTP, repositories know the database but no rules.** `app.ts` and
`server.ts` are separate so tests can drive the app in-process with no port.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server, restarts on save |
| `npm test` | Run all tests once (needs Postgres running) |
| `npm run test:watch` | Re-run tests as you edit |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npx prisma studio` | Browse the database at `localhost:5555` |
| `npx prisma migrate dev --name <name>` | Create and apply a migration |
| `npx tsx mail-check.ts [email]` | Send both real emails through the current driver |

---

## Tests

```bash
docker compose up -d
npm test
```

37 tests, two layers:

- `src/shared/crypto/crypto.test.ts` — hashing, tokens, friend codes. No database.
- `src/modules/auth/auth.test.ts` — all nine endpoints against a real Postgres
  via Supertest, one test per acceptance criterion.

Integration tests use a real database rather than a mocked Prisma, because the
behaviour worth testing lives there: unique constraints, transactions, and the
conditional update that makes token rotation safe.

---

## Roadmap

- [x] Project setup, config, error handling, logging
- [x] Auth: register, login, sessions, verification, password reset
- [ ] Profile, friend codes, friend connections, QR
- [ ] Groups and membership
- [ ] Balance engine — split arithmetic and pairwise balances, tested before any
      expense endpoint touches real data
- [ ] Expenses and settlements
- [ ] Redis: per-origin rate limiting

---

## License

ISC
