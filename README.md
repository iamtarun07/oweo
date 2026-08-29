# Oweo — backend

> *"Who owes whom?"* — an expense-sharing API. Split a bill, track who owes what,
> settle up.

Express + TypeScript REST API with a complete authentication system: a two-step
signup that confirms the email with a 6-digit code before the account exists,
sessions with rotating refresh tokens, and password reset by one-time code.

**Status:** authentication complete and tested (41 tests). Groups, expenses and
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
| `APP_BASE_URL` | `http://localhost:4000` | The API's own public URL |
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
| `POST` | `/auth/register` | — | Step 1 of signup: email a 6-digit code (`202`) |
| `POST` | `/auth/verify-email` | — | Step 2: confirm the code, **create the account**, return both tokens (`201`) |
| `POST` | `/auth/verify-email/resend` | — | New code (rate limited, always answers `200`) |
| `POST` | `/auth/login` | — | Returns both tokens |
| `GET` | `/auth/me` | Bearer | Current user |
| `POST` | `/auth/refresh` | — | Exchange a refresh token for a new pair |
| `POST` | `/auth/logout` | Bearer | Revoke this device's session (`204`) |
| `POST` | `/auth/forgot-password` | — | Email a 6-digit code |
| `POST` | `/auth/reset-password` | — | Verify the code and set a new password |
| `GET` | `/health` | — | Liveness plus a database check |

### Signup is two requests

The account does not exist until the emailed code is confirmed. Registering
writes a `PendingSignup` row — the hashed password and the hashed code — and
nothing else, so an abandoned signup leaves no junk `User` row behind and does
not reserve the address.

```bash
# 1. Details screen -> 202, a code is emailed
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Aarav","lastName":"Sharma","email":"aarav@example.com","password":"correct-horse-battery"}'
```

```jsonc
{ "data": { "email": "aarav@example.com",
            "message": "We've sent a 6-digit code to your email." } }
```

```bash
# 2. Code screen -> 201, the account now exists and you are signed in
curl -X POST http://localhost:4000/api/v1/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"email":"aarav@example.com","otp":"483920"}'
```

```jsonc
{ "data": {
    "accessToken":  "eyJhbGciOiJIUzI1NiIs...",   // JWT, 15 minutes
    "refreshToken": "nuR4gsX_6Jgjx30R1ILA...",   // opaque, 30 days
    "user": { "id": "6de3f3f4-...", "firstName": "Aarav", "lastName": "Sharma",
              "email": "aarav@example.com", "emailVerified": true,
              "friendCode": "XK8MA95" } } }
```

Two consequences worth knowing before you build the screen:

- **Two people may hold a pending signup for one address.** Nothing claims the
  email until a code is confirmed. Whoever confirms first gets the account; the
  other is told `EMAIL_ALREADY_EXISTS` at step 2, decided by the unique index
  rather than by a check that could race.
- **`/verify-email/resend` always answers `200`, even when rate-limited.** It is
  a public endpoint — the caller has no account yet, so it cannot require a
  token — and a `429` there would reveal which addresses are mid-signup. Show the
  usual 60-second countdown on the Resend button; do not wait for the API to say
  no.

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

**Six-digit codes** — used for both signup and password reset. A million
combinations is nothing on its own, so a code is safe only because three limits
apply together: five attempts, five-minute expiry, and one use. Reset adds three
requests per hour; signup adds one per minute and five per day per address.
Codes are hashed at rest and always looked up scoped to one user or one email —
never "does any row hold this hash?", which would let one person's code unlock
another person's account. Completing a reset revokes every session on every
device.

**Confirming a code is not idempotent** — replaying a spent signup code returns
`OTP_INVALID`, not tokens. The tempting alternative ("this address is already
verified, so sign them in") would turn knowledge of an email address into a
login.

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

41 tests, two layers:

- `src/shared/crypto/crypto.test.ts` — hashing, tokens, friend codes. No database.
- `src/modules/auth/auth.test.ts` — all nine endpoints against a real Postgres
  via Supertest, one test per acceptance criterion.

Integration tests use a real database rather than a mocked Prisma, because the
behaviour worth testing lives there: unique constraints, transactions, and the
conditional update that makes token rotation safe.

---

## Roadmap

- [x] Project setup, config, error handling, logging
- [x] Auth: two-step signup by email code, login, sessions, password reset
- [ ] Profile, friend codes, friend connections, QR
- [ ] Groups and membership
- [ ] Balance engine — split arithmetic and pairwise balances, tested before any
      expense endpoint touches real data
- [ ] Expenses and settlements
- [ ] Redis: per-origin rate limiting

---

## License

ISC
