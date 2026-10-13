# Absensi CV Anugerah Jaya Abadi

Monorepo for the employee attendance PWA and its REST API. The API foundation and the
first responsive PWA shell are in place; product workflows continue task-by-task in
[`docs/TODO-implementation-plan.md`](docs/TODO-implementation-plan.md).

## Backend foundation

- `apps/api`: Fastify 5 REST API, TypeScript ESM, versioned under `/api/v1`.
- `apps/web`: React + Vite PWA shell with separate guarded areas for employees,
  supervisors, and admins.
- `apps/api/src/modules`: modular backend for auth, employee, account, store,
  device binding, audit, and other product domains as they are implemented.
- `packages/*`: reserved for shared packages such as the future API contracts.
- PostgreSQL and Prisma are the selected persistence stack. The schema and migrations
  live under `apps/api/prisma`; generated client files are created during builds.

## Local development

Requirements: Node.js `>=22.12.0`, pnpm `11.25.0` (pinned by `package.json`), and
Docker Engine/Desktop with Docker Compose v2. Check `pnpm --version`; it must print
`11.25.0`.

```sh
pnpm install
```

Copy `.env.example` to `.env` in the repository root. Set `POSTGRES_PASSWORD` to a
new local-only random value; a URL-safe hexadecimal value can be generated with
`node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Set `DATABASE_URL`
to `postgresql://absen_local:<same-password>@127.0.0.1:5433/absen_local_demo?schema=public`.
Using hexadecimal avoids URL-encoding ambiguity. Keep `.env` uncommitted and leave demo
passwords empty unless you intend to create demo accounts.

Start and initialize the local database:

```sh
pnpm db:start
pnpm db:generate
pnpm db:migrate:dev
```

`db:start` waits for PostgreSQL's healthcheck. Compose pins PostgreSQL 17.11, exposes
it only on `127.0.0.1:5433` (not standard port 5432), and stores data in the named
`absen_cv_anugerah_jaya_abadi_local_postgres_data` volume. `pnpm db:stop` stops the
container without deleting its volume or data. Do not use `docker compose down -v`,
volume prune/reset, or migration commands against a database other than this local
demo database.

### Optional synthetic demo data

Set `SEED_DEMO_DATA=true` in the untracked root `.env` and provide four distinct,
strong local-only passwords (at least 16 characters): `DEMO_ADMIN_1_PASSWORD`,
`DEMO_ADMIN_2_PASSWORD`, `DEMO_SUPERVISOR_PASSWORD`, and `DEMO_EMPLOYEE_PASSWORD`.
The seeder hashes them with the existing Argon2id auth utility and sets
`mustChangePassword`; no password values are stored in source or `.env.example`. Then run:

```sh
pnpm db:seed
```

The seeder refuses production/staging, requires this explicit opt-in, and accepts only
the `absen_local` PostgreSQL user at `127.0.0.1:5433/absen_local_demo`; it also checks
the connected database and role before writing. Stable synthetic IDs make reruns
idempotent, and seed never deletes records. Demo usernames are `demo.admin.1`,
`demo.admin.2`, `demo.supervisor`, and `demo.employee`; read the local passwords from
`.env`. Never copy these credentials or the database URL to a hosted environment.

Fixtures use fictional names/NIKs, a clearly marked synthetic store at `0,0`, a
weekday shift, a far-future demo holiday, and one pending synthetic leave request.
`EmployeeStore` links an Employee to a store; its `assignedByUserAccountId` identifies
the actor who created that link, not a Supervisor's authorization scope. The current
schema has no Supervisor-to-store scope model or daily-attendance aggregate, so seed
does not create an `EmployeeStore` row for the Supervisor or assign a Supervisor scope.
It creates no attendance, attendance-attempt, device, selfie, location, or final
attendance-status evidence. The pending request has no attachment; no fake photo or
proof is created.

### Run the applications

`pnpm dev:all` starts API and web together. The API listens on
`http://127.0.0.1:3000`; web is served at `http://localhost:5173`, matching
`APP_ORIGIN` for the API's exact Origin/CSRF check. Vite forwards `/api` to
`http://127.0.0.1:3000`. Alternatively, run `pnpm dev` and `pnpm dev:web` in separate
terminals. API liveness endpoint: `GET http://127.0.0.1:3000/api/v1/health`.

Override the Vite development proxy target through `apps/web/.env`
(`VITE_API_PROXY_TARGET`), keeping it aligned with the API host and port. The PWA
precaches only its static app shell; it does not cache API responses. Offline attendance
captures are stored in an AES-GCM-encrypted IndexedDB queue and sync in the foreground only,
after the employee session has been re-verified with the server. “Belum tersinkron” is a local
pending label, not a server receipt or proof. Real-browser and device behavior has not yet been
verified.
Regenerate the install icons with `pnpm --filter @absen/web icons:generate` after
changing the source mark.

The API and Prisma CLI load `.env` from the repository root; values already provided
by the shell/CI take precedence. Empty optional values can stay blank.

The liveness endpoint reports that the process is responding; it does not claim that
future database or external services are ready.

Runtime settings are validated at startup. Supported environments are
`development`, `test`, `staging`, and `production`.

| Variable                   | Default                                                          | Purpose / validation                                                                                                  |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development`                                                    | Runtime mode: `development`, `test`, `staging`, or `production`.                                                      |
| `HOST`                     | `127.0.0.1` in development/test; `0.0.0.0` in staging/production | API bind interface; explicit `HOST` always takes precedence (set as required by deployment/networking).               |
| `PORT`                     | `3000`                                                           | TCP port from 1 through 65535.                                                                                        |
| `LOG_LEVEL`                | `info` (`silent` in test mode)                                   | Pino log level.                                                                                                       |
| `TIMEZONE`                 | `Asia/Jakarta`                                                   | Only `Asia/Jakarta` is accepted (PRD NFR-07); unset/empty uses this default and other values fail at startup.         |
| `DATABASE_URL`             | unset                                                            | PostgreSQL URL for the local Compose database/API and Prisma CLI.                                                     |
| `POSTGRES_PASSWORD`        | unset                                                            | Local Compose database password; keep only in untracked `.env`.                                                       |
| `SEED_DEMO_DATA`           | `false`                                                          | Demo seed opt-in; must be exactly `true` to write synthetic accounts/data.                                            |
| `DEMO_*_PASSWORD`          | unset                                                            | Local-only demo role passwords; no defaults are provided.                                                             |
| `SESSION_SECRET`           | unset                                                            | Optional in development/test/staging. Required in production, at least 32 characters with at least 16 distinct chars. |
| `STORAGE_ENDPOINT`         | unset                                                            | Optional object-storage endpoint URL.                                                                                 |
| `STORAGE_BUCKET`           | unset                                                            | Bucket name; required together with access and secret keys when storage is configured.                                |
| `STORAGE_ACCESS_KEY`       | unset                                                            | Generic object-storage access key; do not commit its value.                                                           |
| `STORAGE_SECRET_KEY`       | unset                                                            | Generic object-storage secret; do not commit its value.                                                               |
| `NOTIFICATION_PROVIDER`    | unset                                                            | Provider identifier, intentionally not tied to a vendor.                                                              |
| `NOTIFICATION_CREDENTIALS` | unset                                                            | Opaque provider-specific credentials; required provider identifier when supplied.                                     |
| `SELFIE_RETENTION_MONTHS`  | `12`                                                             | Selfie retention default from the PRD; must be a positive integer.                                                    |
| `FEATURE_FLAGS`            | `{}`                                                             | JSON object mapping feature names to boolean values; defaults to no environment overrides.                            |

The health endpoint and local development do not require database, session, storage, or
notification secrets. Production startup fails when `SESSION_SECRET` is absent or does
not meet the strength checks. If any storage setting is provided, bucket, access key,
and secret key must all be present; the endpoint may be omitted for providers with a
default endpoint. Notification credentials may be omitted for providers that do not
need them. Do not put real credentials in `.env.example`, source control, or logs.

## Quality commands

```sh
pnpm format       # Apply Prettier to application and root config files
pnpm format:check # Check formatting
pnpm lint         # ESLint flat config
pnpm typecheck    # TypeScript check for workspace packages
pnpm test         # Vitest tests for workspace packages
pnpm build        # Build workspace packages
pnpm check        # Run all checks above in sequence
```

Check applied migrations with `pnpm db:migrate:status` after starting the local DB.

API errors use `application/problem+json` (RFC 9457) with a stable `code` extension and
a generated request ID. Pino emits structured logs; authorization/cookie headers and
common sensitive fields are redacted, and request bodies are not logged by default.
See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the architecture record.
