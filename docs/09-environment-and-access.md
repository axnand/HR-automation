# 09 — Environment Variables and Access Handover

---

## Environment variables

These are every `process.env.*` reference found in the application code. Variables defined in `.env.example` but never read by the code are not listed.

### Required (app will not start without these)

| Variable | Where it's set | What it's for |
|---|---|---|
| `DATABASE_URL` | Vercel + Railway | Prisma connection string (via PgBouncer for connection pooling). Format: `postgresql://user:pass@host:port/db?sslmode=require` |
| `DIRECT_URL` | Vercel + Railway | Direct Postgres connection (bypasses PgBouncer). Used by Prisma for migrations. Also used by pg-boss (`DIRECT_DATABASE_URL` or falls back to `DATABASE_URL`). |
| `DIRECT_DATABASE_URL` | Railway worker | Direct URL for pg-boss specifically (see [lib/queue.ts:13](../lib/queue.ts#L13)). Can be the same as `DIRECT_URL`. |

### Unipile (LinkedIn scraping + outreach)

| Variable | Where | What |
|---|---|---|
| `UNIPILE_DSN` | Vercel + Railway | Unipile data-source name — the `https://` API base URL for your Unipile instance. Per-account overrides in `Account.dsn` take precedence when set. |
| `UNIPILE_API_KEY` | Vercel + Railway | Unipile API key. Per-account overrides in `Account.apiKey` take precedence when set. |
| `UNIPILE_WEBHOOK_SECRET` | Vercel | The shared secret included in every webhook delivery (`x-unipile-secret` header). Must match what was registered via `POST /api/webhooks/unipile/register`. Missing in production → all webhooks rejected. |

### AI / LLM

| Variable | Where | What |
|---|---|---|
| `OPENAI_API_KEY` | Vercel + Railway | Fallback OpenAI key used when no `AiProvider` row is configured in the DB. Once providers are configured via Settings, this is not needed. |

### AWS S3 (resume storage)

| Variable | Where | What |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Vercel | AWS access key for S3 uploads (resume PDFs) |
| `AWS_SECRET_ACCESS_KEY` | Vercel | AWS secret key |
| `AWS_S3_REGION` | Vercel | S3 bucket region, e.g. `ap-south-1` |
| `AWS_S3_BUCKET` | Vercel | S3 bucket name |

### Security / Auth

| Variable | Where | What |
|---|---|---|
| `CRON_SECRET` | Vercel + Railway | Bearer token that Vercel injects into cron requests. All cron routes and the poll-acceptances route check this in production. Set the same value in the external scheduler's Authorization header. |
| `EXTENSION_SECRET` | Vercel | Secret for the Chrome extension config endpoint (`/api/extension/config`). Only needed if the extension integration is active. |

### Application config

| Variable | Where | What |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Vercel | Public URL of the deployed app, e.g. `https://hirro.vercel.app`. Used for constructing webhook registration URLs. |
| `VERCEL_URL` | Vercel (auto-injected) | Auto-set by Vercel. Fallback for `NEXT_PUBLIC_APP_URL` in webhook registration. |
| `DATA_RETENTION_DAYS` | Vercel | If > 0, the `process-tasks` maintenance cron nulls out `CandidateProfile.rawProfile` for profiles older than this many days. Set to 0 (or omit) to keep raw profiles forever. |
| `POLL_ACCEPTANCES_COOLDOWN_SECS` | Vercel | Cooldown between successive poll-acceptances runs (guards against the external cron firing too often). Optional. |

### External integrations

| Variable | Where | What |
|---|---|---|
| `AIRSCALE_API_KEY` | Vercel | API key for Airscale — the contact enrichment provider. Used by `GET /api/airscale/credits` and the enrichment route. Optional if enrichment is not used. |
| `NEXT_PUBLIC_LIVEKIT_URL` | Vercel | LiveKit server URL for the experimental interview room. Only needed if `/interview` is used. |

---

## Where credentials live

| Credential | Stored in |
|---|---|
| All Vercel env vars | Vercel dashboard → Project Settings → Environment Variables |
| Railway env vars (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `UNIPILE_*`, `OPENAI_API_KEY`) | Railway dashboard → Service → Variables |
| Unipile account credentials | Also stored in the `Account` table (DSN + API key per account) — managed via the Settings → Accounts UI |
| LLM provider API keys | Stored in the `AiProvider` table — managed via Settings → AI Providers UI |
| Google Apps Script web app URL (sheet export) | Stored in `SheetIntegration` table and `AppSettings.sheetWebAppUrl` — managed via Settings → Sheet Integrations UI |
| PostgreSQL credentials | On the E2E server (owned by the Promos team). Ask the Promos team for the connection string. |

---

## Access handover checklist

When handing this project to a new maintainer:

### Vercel

- [ ] Add new maintainer to the Vercel team (or transfer project ownership)
- [ ] Share all environment variable values from the Vercel dashboard
- [ ] Confirm the cron schedule in `vercel.json` is still active (check Vercel → Deployments → Cron Jobs tab)

### Railway

- [ ] Add new maintainer to the Railway project
- [ ] Share the Railway environment variables (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `UNIPILE_DSN`, `UNIPILE_API_KEY`, `OPENAI_API_KEY`, `CRON_SECRET`)
- [ ] Confirm the Railway service is running (`npm run worker` / `tsx worker.ts`)
- [ ] Check the Railway service's restart policy is set to "Always"

### External scheduler (cron-job.org)

- [ ] Share login for cron-job.org
- [ ] The job should be hitting `GET https://<app-url>/api/cron/poll-acceptances` with header `Authorization: Bearer <CRON_SECRET>`
- [ ] Confirm it's enabled and the CRON_SECRET matches

### Unipile

- [ ] Share Unipile dashboard login
- [ ] Confirm webhook is registered pointing to `https://<app-url>/api/webhooks/unipile` with the `x-unipile-secret` header
- [ ] Share all LinkedIn account credentials (if per-account DSN/API keys are used)

### Database (E2E server)

- [ ] Contact the Promos team to hand over or transfer PostgreSQL access
- [ ] Share the `DATABASE_URL` and `DIRECT_URL` strings
- [ ] Confirm the new maintainer can run `npx prisma migrate deploy` against the production DB

### AWS S3

- [ ] Share or rotate the AWS IAM credentials for the S3 bucket
- [ ] The IAM user needs `s3:PutObject` and `s3:GetObject` on the bucket

### GitHub

- [ ] Transfer or add collaborator to the `salescode-hirro` repository
- [ ] Confirm the new maintainer has push access to `main`

### LLM Providers

- [ ] Check Settings → AI Providers in the app UI — API keys are stored in the `AiProvider` table
- [ ] Share the underlying OpenAI / Anthropic / Gemini account credentials so the new maintainer can rotate keys if needed
