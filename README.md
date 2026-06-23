# QSC Grader Orchestration POC

A proof-of-concept for managing the end-to-end workflow of manually grading learner exam submissions retrieved from the Intellum LMS platform. Admins assign submissions to graders, graders work through their queue, and grades are written back to Intellum — with a full audit trail at every step.

---

## What This Is

QSC certifications require human graders to review and score learner submissions. This system orchestrates that process:

- **Pulls** new submissions from Intellum (`NEEDS_GRADING` status) on a schedule or manually
- **Queues** them per exam in FIFO order
- **Allows admins** to assign, reassign, and unassign submissions to specific graders
- **Allows graders** to start work, then submit a PASS or FAIL result
- **Writes grades back** to Intellum and records every action in an immutable audit trail
- **Enforces** per-grader WIP limits, role-based authorization, and idempotency throughout

This POC replaces manual coordination (spreadsheets, email) with a purpose-built workflow UI backed by a persistent API and database.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React UI)  ←→  Orchestration API  ←→  PostgreSQL      │
│  http://localhost:5173     http://localhost:8789                  │
│                                    ↕                             │
│                          Mock Intellum LMS                       │
│                          http://localhost:8788                   │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Technology | Purpose |
|---|---|---|
| UI | React 18 + Vite + TypeScript | Admin dashboard and grader console |
| API | Hono.js on Node.js | Assignment workflow, auth, sync endpoints |
| Database | PostgreSQL 16 (Docker) | Persistent state, assignments, audit events |
| Mock LMS | Hono.js + SQLite | Simulates Intellum submission pool and grade writeback |
| Contracts | TypeScript types package | Shared types across all services |

### Workflow State Machine

```
Intellum (NEEDS_GRADING)
        │  polling / manual sync
        ▼
 [Unassigned Queue]
        │  admin assigns
        ▼
    ASSIGNED  ──── admin unassigns ──→  [Unassigned Queue]
        │  grader starts work
        ▼
   IN_PROGRESS ─── admin unassigns ──→  [Unassigned Queue]
        │  grader submits PASS or FAIL
        ▼
     GRADED  ──→  writeback to Intellum  ──→  audit event recorded
```

---

## Repository Structure

```
qsc-grader-orchestration/
├── apps/
│   ├── orchestration/          # Core API server (port 8789)
│   │   └── src/
│   │       ├── index.ts        # All HTTP endpoints + startup validation
│   │       ├── db.ts           # PostgreSQL store (schema, queries, migrations)
│   │       ├── assignments.ts  # Business logic engine (WIP limits, idempotency)
│   │       ├── auth.ts         # JWT signing and middleware
│   │       └── sync.ts         # Intellum polling / watermark logic
│   │
│   ├── mock-intellum/          # Simulated Intellum LMS (port 8788)
│   │   └── src/
│   │       ├── index.ts        # Submission list + grade writeback endpoints
│   │       └── db.ts           # SQLite store with 112 seeded submissions
│   │
│   └── mock-qsc-ui/            # React admin + grader UI (port 5173)
│       └── src/
│           ├── App.tsx         # Full single-page app (admin + grader views)
│           └── app.css         # Design system styles
│
├── packages/
│   └── contracts/              # Shared TypeScript types (Submission, QueueItem, etc.)
│       └── src/index.ts
│
├── scripts/
│   └── smoke-api.mjs           # One-command end-to-end smoke validator
│
├── docker-compose.yml          # PostgreSQL 16 container
├── package.json                # npm workspaces root
└── SPRINT*.md                  # Sprint documentation and test guides
```

---

## Prerequisites

- **Node.js** 20 or later
- **Docker Desktop** (for PostgreSQL)
- **npm** 10 or later

---

## Quick Start

**1. Clone and install dependencies**
```bash
git clone https://github.com/gpwillia/qsc-grader-orchestration.git
cd qsc-grader-orchestration
npm install
```

**2. Start the database**
```bash
docker-compose up -d
```

**3. Start all services** (three separate terminals)
```bash
# Terminal 1 — Mock Intellum LMS
npm run dev:mock-intellum

# Terminal 2 — Orchestration API
DATABASE_URL="postgresql://qsc_user:qsc_password@localhost:5432/qsc_orchestration" \
npm run dev:orchestration

# Terminal 3 — React UI
npm run dev:ui
```

**4. Open the UI**

Navigate to http://localhost:5173

| Role | Email | Password |
|---|---|---|
| Admin | admin@qsc.demo | admin |
| Grader | grader1@qsc.demo | grader |
| Grader | grader2@qsc.demo | grader |
| Grader | grader3@qsc.demo | grader |

---

## Demo Walkthrough

### Admin flow
1. Sign in as `admin@qsc.demo`
2. The system auto-syncs on login — the unassigned queue populates with submissions
3. Select an exam from the dropdown (e.g. `EXAM-AUDIO-101`)
4. Pick a grader from the **Assign** column dropdown, click **Assign**
5. The item moves to **Active Assignments** with state `ASSIGNED`
6. Use **Reassign** or **Unassign** to rebalance work
7. Click **History** on any row to see the full audit timeline

### Grader flow
1. Sign in as `grader1@qsc.demo`
2. Assigned items appear in **My Queue** with state `ASSIGNED`
3. Click **Start Work** — state transitions to `IN_PROGRESS`
4. Click **PASS** or **FAIL** to submit the grade
5. The item disappears from the active queue
6. The **Recently Graded By You** panel shows completed work

---

## API Reference

Base URL: `http://localhost:8789`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Service health and queue counts |
| `POST` | `/api/auth/login` | — | Returns JWT token |
| `GET` | `/api/auth/me` | Any | Current user info |
| `POST` | `/api/sync` | Admin | Pull new submissions from Intellum |
| `GET` | `/api/graders` | Admin | List all graders |
| `GET` | `/api/exams/:examId/queue` | Admin | Unassigned queue for an exam |
| `GET` | `/api/graders/:id/queue` | Admin/Self | Active queue for a grader |
| `GET` | `/api/graders/:id/recent-graded` | Admin/Self | Recently completed by grader |
| `POST` | `/api/assignments` | Admin | Assign submission to grader |
| `POST` | `/api/assignments/:id/start` | Grader | Move to IN_PROGRESS |
| `POST` | `/api/assignments/:id/grade` | Grader | Submit PASS or FAIL |
| `POST` | `/api/assignments/:id/reassign` | Admin | Move to different grader |
| `POST` | `/api/assignments/:id/unassign` | Admin | Return to unassigned queue |
| `GET` | `/api/submissions/:id/history` | Any | Full audit event timeline |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `INTELLUM_API_BASE_URL` | `http://localhost:8788` | Intellum API base URL |
| `JWT_SECRET` | `local-dev-secret-change-me` | Must be overridden in production |
| `JWT_EXPIRES_IN` | `8h` | Token expiry duration |
| `PORT` | `8789` | API server port |
| `CORS_ORIGINS` | *(localhost:5173)* | Comma-separated allowed origins |
| `POLL_INTERVAL_SECONDS` | `0` | Auto-sync interval (0 = off) |

---

## Testing

### One-command smoke test
Validates auth, sync, all 4 exam queues, assign/start/grade flow, audit events, and grade writeback:
```bash
npm run smoke:api
```

Expected output:
```
[ok] API reachable. cachedSubmissions=111
[ok] Admin login
[ok] Sync complete.
[ok] EXAM-AUDIO-101: 27 unassigned
...
[ok] Graded sub-XXXX PASS
[pass] Smoke test completed successfully
```

### Manual E2E testing
See [SPRINT3_E2E_TESTING.md](SPRINT3_E2E_TESTING.md) for the full 8-phase test guide covering authentication, sync, queue inspection, assignment workflow, reassignment, WIP limits, audit history, and edge cases.

### Database reset (for a clean demo)
```bash
docker-compose down -v
docker-compose up -d
# Restart orchestration service — schema and seed users are re-applied automatically
```

---

## Key Design Decisions

**Idempotency at two levels**
- DB unique constraint prevents duplicate active assignments per submission
- Grade endpoint checks existing state before writing — same result returns `isIdempotent: true`

**WIP limit enforcement**
- Each grader has a configurable capacity (default 2 active items)
- Admins can unassign to rebalance at any time

**Audit trail**
- Every state transition writes an immutable event: `ASSIGNED`, `STARTED`, `GRADED`, `REASSIGNED`, `UNASSIGNED_BY_ADMIN`, `GRADE_WRITEBACK_SUCCEEDED`, `GRADE_WRITEBACK_FAILED`
- Events are never deleted, providing a complete history per submission

**Grade writeback resilience**
- Orchestration POSTs the grade to Intellum with 3 automatic retries
- Local grade state is always persisted first; writeback failure is surfaced in the audit trail and returns HTTP 502

---

## Sprint History

| Sprint | Focus | Status |
|---|---|---|
| 3 | Assignment workflow engine, audit trail, idempotency | ✅ Complete |
| 4 | Admin dashboard UI | ✅ Complete |
| 5 | Grader console UI | ✅ Complete |
| Tech Debt | Writeback, hardening, UX, docs, smoke test | ✅ Complete |
