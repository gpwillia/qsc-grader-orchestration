# Local Development Setup

## Postgres for Orchestration

### Option 1: Docker Compose (Recommended)

```bash
docker-compose up -d
```

This starts a local Postgres instance on `localhost:5432` with default credentials:
- User: `qsc_user`
- Password: `qsc_password`
- Database: `qsc_orchestration`

Create a `.env` file in `apps/orchestration/`:

```bash
PORT=8789
DATABASE_URL=postgresql://qsc_user:qsc_password@localhost:5432/qsc_orchestration
JWT_SECRET=local-dev-secret
JWT_EXPIRES_IN=8h
INTELLUM_API_BASE_URL=http://localhost:8788
POLL_INTERVAL_SECONDS=30
```

Then start the services:

```bash
# Terminal 1: Mock Intellum
npm run dev:mock-intellum

# Terminal 2: Orchestration
npm run dev:orchestration

# Terminal 3: Mock UI
npm run dev:ui
```

### Option 2: Managed Postgres (Neon/Supabase)

If you prefer cloud hosting during development, create a free Postgres database on [Neon](https://neon.tech) or [Supabase](https://supabase.com) and provide the `DATABASE_URL` in your `.env` file.

### Sprint 2 Runtime Validation Checklist

Once Postgres is available, run these smoke tests:

**Auth:**
```bash
# Login
curl -X POST http://localhost:8789/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@qsc.demo","password":"admin"}'

# Extract token from response, then:
curl http://localhost:8789/api/auth/me \
  -H 'authorization: Bearer <TOKEN>'
```

**Sync:**
```bash
# Manual sync (admin-authenticated)
curl -X POST http://localhost:8789/api/sync \
  -H 'authorization: Bearer <ADMIN_TOKEN>'

# Should return:
# { "skipped": false, "reason": "manual", "stats": { "fetched": 112, "upserted": 112, "skippedLocked": 0, ... } }
```

**Health:**
```bash
curl http://localhost:8789/health

# Expected output:
# { "service": "orchestration", "ok": true, "cachedSubmissions": 112, "assigned": 0, "inProgress": 0, ... }
```

**Cron Integration (Cloud Deployment):**

In Cloudflare Workers or your scheduler, POST to `/internal/poll` with `x-cron-token` header.
