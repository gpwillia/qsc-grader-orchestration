# QSC Grader Orchestration — Sprint Backlog

Stack: TypeScript monorepo · React/Vite · Managed Postgres · JWT session auth  
Repo model: Monorepo with shared contracts package and independent deploys per app  
Deployment target: Cloudflare Workers + Cron Triggers + Pages + managed Postgres  
Build order: Mock Intellum → Orchestration → QSC UI

Monorepo layout:
- apps/mock-intellum
- apps/orchestration
- apps/mock-qsc-ui
- packages/contracts

---

## State Ownership Model

| Status | Owned by |
|---|---|
| NEEDS_GRADING | Intellum (source of truth) |
| ASSIGNED | Orchestration |
| IN_PROGRESS | Orchestration |
| GRADED (PASS/FAIL) | Intellum (after orchestration posts result) |

**Polling rule:** polling only creates or updates records that are still `NEEDS_GRADING` in Intellum.  
It must never revert an item that is already `ASSIGNED` or `IN_PROGRESS` in orchestration back to `NEEDS_GRADING`, even if Intellum still reports `NEEDS_GRADING` for that submission. Once orchestration takes ownership, it is authoritative for assignment state.

---

## Sprint 0: Setup and Shared Contracts

**Goal:** establish repo, shared types, local runtime, test harness, and deployment architecture decisions.

### Tasks

- Create monorepo structure with workspaces:
  - apps/mock-intellum
  - apps/orchestration
  - apps/mock-qsc-ui
  - packages/contracts
- Set up independent app builds and deploy configs so each app is deployable on its own lifecycle
- Define shared TypeScript domain models in packages/contracts:
  - Submission statuses: `NEEDS_GRADING`, `ASSIGNED`, `IN_PROGRESS`, `GRADED_PASS`, `GRADED_FAIL`
  - Roles: `ADMIN`, `GRADER`
  - Assignment states, grade results, API payloads
- Configure local development databases:
  - mock-intellum: SQLite (demo data source)
  - orchestration: managed Postgres via Neon/Supabase connection
- Add environment configuration and local run scripts
- Add linting, formatting, and test scaffolding
- Seed demo users: 1–2 admins, 2–3 graders
- Define acceptance checklist template for each layer validation gate

### Contracts Versioning Discipline

- Treat packages/contracts as a versioned API surface with semantic versioning.
- Version bump policy:
  - MAJOR: breaking contract changes (field removals, incompatible enum change)
  - MINOR: additive backward-compatible changes (new optional fields, new endpoints)
  - PATCH: docs/typing fixes that do not alter runtime shape
- Every contract change requires:
  - changelog entry with migration notes
  - consumer impact check for all three apps
  - explicit version pin or controlled range in each app
- CI rule: each app builds against its declared contracts version; no implicit local drift.

### Deployment Architecture Decision (Sprint 0)

Document the Cloudflare deployment model before writing the polling job so local and cloud implementations align:

- **Polling:** Cloudflare Workers do not support long-lived cron loops. The polling job runs via a **Cloudflare Cron Trigger** (a scheduled Worker invocation on a fixed interval). Locally, this is replicated by a simple interval timer or a manual `POST /api/sync` trigger.
- **DB choice:** decide between Cloudflare D1 (SQLite-compatible, zero-infra) and managed Postgres (Neon/Supabase) before Sprint 2. D1 is simplest for demo; Postgres gives a cleaner upgrade path to production.
- Record the decision in a short ADR (Architecture Decision Record) so there is no rework when deploying to Cloudflare.

### Stories

1. As a developer, I want a shared domain model so all services use the same contract.
2. As a developer, I want a shared versioned contracts package so all apps can evolve safely using semver.
3. As a developer, I want local startup scripts so I can run all three layers consistently.
4. As a developer, I want seeded users and config so I can test auth and roles early.
5. As a developer, I want an agreed Cloudflare deployment model documented so the polling job is written correctly from day one.
6. As an engineering lead, I want independent deploys per app so releases can be decoupled while staying contract-compatible.

### Acceptance Criteria

- All apps start locally
- apps consume shared contracts from packages/contracts
- Contracts package has versioning policy and changelog workflow defined
- mock-intellum SQLite is connected and queryable
- orchestration Postgres is connected and queryable
- Demo users are documented and usable
- Each app can build and deploy independently
- Deployment ADR is written and agreed (Cron Trigger + D1 vs Postgres)

---

## Sprint 1: Mock Intellum API

**Goal:** create the system-of-record simulator with realistic seed data, grade endpoints, and admin detail view.

### Tasks

- Implement submission entity and SQLite storage
- Seed ~100 submissions across multiple exams
- Include retake/resubmission cases via multiple attempts per learner+exam
- Build `GET /api/submissions?status=NEEDS_GRADING&since=...`
- Build `GET /api/submissions/:id`
- Build `POST /api/submissions/:id/grade`
  - Accepts `{ result: PASS | FAIL, graded_by, graded_at }`
  - Updates status to `GRADED_PASS` or `GRADED_FAIL`
- Build `GET /admin/submissions/:id` — read-only HTML (deep-link target)
- Add role check: admin-only access to detail page

### Stories

1. As the orchestration layer, I want to fetch new `NEEDS_GRADING` submissions filtered by `since` so I can build queues without re-processing old records.
2. As an admin, I want a read-only submission detail page so I can inspect the source record through a deep link.
3. As the orchestration layer, I want to post a `PASS` or `FAIL` outcome so Intellum remains the system of record for grading results.

### Acceptance Criteria

- Seeded `NEEDS_GRADING` submissions are returned correctly
- `since` timestamp filtering works and is stable under repeated calls
- Grade endpoint updates the stored record and returns the updated status
- Read-only admin detail page is accessible only to admin-authenticated requests
- Retake/attempt records are present and distinguishable by `attempt_id`

---

## Sprint 2: Orchestration Data Model, Sync, and Auth

**Goal:** stand up the orchestration service, schema, polling sync, and JWT auth.

### Tasks

- Create SQLite schema: `users`, `submissions_cache`, `assignments`, `events`
- Implement `POST /api/auth/login` — returns signed JWT
- Implement `GET /api/auth/me` — returns role and identity
- Implement `POST /api/sync` — manual trigger for development and admin use
- Implement polling job:
  - Locally: interval timer
  - Cloudflare: Cron Trigger (document both entry points)
  - Interval: 30–60 seconds
  - Calls `GET /api/submissions?status=NEEDS_GRADING&since=<last_synced_at>`
  - Upserts into `submissions_cache`
- **Polling safety rule:** on each upsert, check if the submission already exists in orchestration with state `ASSIGNED` or `IN_PROGRESS`. If so, skip the update — do not revert orchestration state.
- Add sync logs and error reporting
- Document the D1 vs managed Postgres decision from Sprint 0 ADR and configure accordingly

### Stories

1. As an admin, I want to manually trigger sync so I can verify ingestion during development.
2. As the orchestration service, I want to poll Mock Intellum so new submissions enter the queue automatically.
3. As a developer, I want the polling job to respect existing orchestration state so `ASSIGNED` and `IN_PROGRESS` items are never accidentally reverted.
4. As a developer, I want the polling job implemented with Cloudflare Cron Trigger compatibility so local and cloud behavior align.

### Acceptance Criteria

- Manual sync ingests new `NEEDS_GRADING` submissions
- Scheduled polling keeps the cache updated
- Items already in `ASSIGNED` or `IN_PROGRESS` state in orchestration are not touched by a subsequent poll, even if Intellum still reports `NEEDS_GRADING`
- Duplicate ingestion is prevented via idempotent upsert
- Auth login returns a valid JWT and `GET /me` returns correct role
- Cron Trigger-compatible polling structure is in place

---

## Sprint 3: Assignment, State Transitions, Idempotency, and Audit

**Status: ✅ COMPLETE**

**Goal:** implement the workflow engine, business rules, idempotency guards, and full audit trail.

### Implementation Summary

All Sprint 3 requirements have been implemented in TypeScript with full type safety:

**New Modules:**
- `apps/orchestration/src/assignments.ts` — Business logic engine with idempotency coordination
- Enhanced `apps/orchestration/src/db.ts` — Schema updates with unique constraints and queue queries
- Updated `apps/orchestration/src/index.ts` — 8 new REST endpoints

**Database Schema Updates:**
- Added `graded_result` column to `submissions_cache` (PASS|FAIL|NULL)
- Added `CONSTRAINT active_assignment_per_submission UNIQUE` on assignments (per-submission unique per active state)
- Added indexes: `idx_assignments_grader_state`, `idx_events_submission` for query performance

**Shared Contracts:**
- Added `QueueItem`, `HistoryRecord`, `AssignmentRequest`, queue response types to packages/contracts

### Implemented Endpoints

1. **GET /api/exams/:examId/queue** — Admin: FIFO-ordered unassigned items per exam
2. **GET /api/graders/:graderId/queue** — Grader: own assigned/in-progress items; admin: any grader's queue
3. **POST /api/assignments** — Admin: assign submission to grader; enforces WIP limit ≤ 2
   - Unique constraint idempotency: duplicate calls return existing assignment
4. **POST /api/assignments/:submissionId/start** — Grader: ASSIGNED → IN_PROGRESS
5. **POST /api/assignments/:submissionId/grade** — Grader: IN_PROGRESS → GRADED
   - Idempotent on result: same grade twice = success without duplicate event/Intellum call
6. **POST /api/assignments/:submissionId/reassign** — Admin: change grader, reset to ASSIGNED
7. **POST /api/assignments/:submissionId/unassign** — Admin: remove assignment, return to unassigned queue
8. **GET /api/submissions/:submissionId/history** — Full audit trail of all workflow events

### Idempotency Implementation

- **Assignment idempotency:** Unique constraint `(submission_id) WHERE state IN ('ASSIGNED', 'IN_PROGRESS')` prevents duplicates
- **Grade idempotency:** Grade endpoint queries `graded_result` in submissions_cache; if already set to same result, returns success without new event or Intellum API call
- All state transitions validated with optimistic locking

### State Ownership & Transitions

| Source | Transition | Target | Trigger |
|--------|-----------|--------|---------|
| NEEDS_GRADING (Intellum) | Polling assigns | ASSIGNED (Orchestration) | Admin POST /assignments |
| ASSIGNED | Grader starts | IN_PROGRESS | Grader POST /start |
| IN_PROGRESS | Grader grades | GRADED (Intellum) | Grader POST /grade |
| ASSIGNED/IN_PROGRESS | Admin unassigns | NEEDS_GRADING (unassigned in Orch) | Admin POST /unassign |

### Audit Events Recorded

- `ASSIGNED`: submission assigned to grader; payload: graderId
- `STARTED`: grader moved item to in-progress; payload: newState
- `GRADED`: grader submitted grade; payload: result (PASS|FAIL)
- `REASSIGNED`: admin changed grader; payload: newGraderId
- `UNASSIGNED_BY_ADMIN`: admin removed assignment; payload: {}

All events include actor_id (user initiating action), timestamp (ISO), and submission_id.

### Testing

End-to-end test guide: [SPRINT3_E2E_TESTING.md](SPRINT3_E2E_TESTING.md)

Covers:
- Authentication and JWT flow
- Manual polling trigger
- Queue inspection (exam + grader)
- Full assignment lifecycle (assign → start → grade)
- Idempotency validation
- Reassignment and unassign workflows
- WIP limit enforcement
- Audit history verification

### Validation Checklist

- ✅ TypeScript build passes with no errors
- ✅ All 8 endpoints defined with proper auth guards
- ✅ Grader-only actions check JWT role
- ✅ Admin-only actions protected with requireAdmin middleware
- ✅ Unique constraint prevents duplicate active assignments
- ✅ Grade idempotency guards implemented
- ✅ Audit events written for all state transitions
- ✅ Queue queries return FIFO-ordered items
- ✅ WIP limit enforced at assignment time
- ✅ Type safety enforced via shared contracts

### Ready for Sprint 4

Sprint 3 establishes the complete backend workflow engine with all business rules, idempotency guarantees, and audit capabilities needed for the admin dashboard (Sprint 4) to manage the grading process.

---

## Sprint 4: Admin UI

**Status: ✅ COMPLETE**

**Goal:** deliver the admin operational dashboard.

Implemented in [apps/mock-qsc-ui/src/App.tsx](apps/mock-qsc-ui/src/App.tsx) with:
- Admin login + JWT session persistence
- Exam queue and active assignment views
- Filters: exam, status, grader, age bucket, search
- Assign, reassign, unassign actions wired to orchestration APIs
- Manual sync trigger, deep link to Mock Intellum admin detail, and submission history timeline
- Error and empty states for operational use

### Tasks

- Build login screen and JWT session handling in React/Vite
- Build exam queue view with FIFO ordering
- Add filters: exam, status, grader, age bucket
- Add assign and reassign actions
- Add **Unassign (return to queue)** action — admin override for demo recovery and production use
- Add past-due indicator (configurable age threshold)
- Add admin-only deep link to Mock Intellum submission detail page
- Add manual sync button
- Add error and empty states

### Stories

1. As an admin, I want to see the queue grouped by exam in FIFO order so I can manage work predictably.
2. As an admin, I want to assign and reassign submissions so I can balance grader workload.
3. As an admin, I want to unassign a submission back to the queue so I can correct mistakes without needing a DB fix.
4. As an admin, I want filters and aging indicators so I can spot exceptions quickly.
5. As an admin, I want to open the source submission detail so I can inspect the original record.

### Acceptance Criteria

- Admin can log in and see the queue
- Queue renders accurately from orchestration APIs
- Assign and reassign actions enforce backend WIP rules
- Unassign action is visible to admins only, clears assignment, and returns item to queue
- Deep links open only for admin-authenticated users
- Filters and queue updates reflect current orchestration state
- Duplicate clicks on Assign do not create duplicate assignments (backend idempotency is surfaced cleanly)

---

## Sprint 5: Grader UI

**Status: ✅ COMPLETE**

**Goal:** deliver the grader workflow from queue to completed grade.

Implemented in [apps/mock-qsc-ui/src/App.tsx](apps/mock-qsc-ui/src/App.tsx) with:
- Role-aware login supporting ADMIN and GRADER users
- Grader My Queue panel backed by GET /api/graders/:graderId/queue
- Start Work action guarded to ASSIGNED items only
- PASS and FAIL actions guarded to IN_PROGRESS items only
- Confirmation prompts and per-item pending states to prevent duplicate clicks
- Submission history panel for grader-facing audit visibility

### Tasks

- Build grader "My Queue" view (assigned items only)
- Add `Start Work` action (`ASSIGNED → IN_PROGRESS`)
- Add `PASS` and `FAIL` submission actions
- Remove completed items from active queue on grade
- Add confirmation states and feedback
- Prevent invalid actions in UI (no grade before start, no action on another grader's item)

### Stories

1. As a grader, I want to see only my assigned items so I can focus on my queue.
2. As a grader, I want to mark work in progress so ownership and activity are visible.
3. As a grader, I want to submit a pass/fail result so the submission can exit the active queue.

### Acceptance Criteria

- Grader sees only their own assigned items
- Start action is only enabled on `ASSIGNED` items
- Grade action completes the flow, updates Intellum, and removes item from active queue
- Double-clicking PASS/FAIL is safe — idempotency is enforced by the backend
- Unauthorized grader actions are blocked at the API level

---

## Sprint 6: Hardening, Demo Readiness, and End-to-End Validation

**Goal:** make the solution reliable and repeatable for demo and stakeholder review.

### Tasks

- Add environment reset/reseed tooling
- Add event history UI showing full submission lifecycle
- Add structured logs across all services
- Add basic smoke tests per layer
- Add end-to-end walkthrough script
- Handle failure cases: over-capacity assignment, invalid transition, already-graded submission
- Verify Cloudflare deployment: Workers + Cron Trigger + Pages + D1/Postgres
- Document final deployment checklist

### Stories

1. As a demo operator, I want to reseed the environment quickly so I can reset the demo flow between runs.
2. As a stakeholder, I want to see the full event history so orchestration logic is credible.
3. As a developer, I want smoke tests per layer so I can verify correctness before demos.
4. As a developer, I want the Cloudflare deployment validated so the handoff from local to cloud does not require rework.

### Acceptance Criteria

- Demo reset completes quickly without manual DB edits
- End-to-end happy path runs without errors
- Common failure cases show clean, informative error states
- Smoke tests pass for each layer independently
- History and audit trail are complete and accurate
- Cloudflare deployment runs end-to-end with Cron Trigger polling active

---

## Cross-Cutting Validation Checklist

Use this after each sprint to confirm the layer works before proceeding.

**After Sprint 1 — Mock Intellum**
- Seeded submissions are listed and filtered by status and `since`
- Grade endpoint updates status correctly
- Admin detail page loads and is role-restricted
- Retake records are distinguishable

**After Sprint 2 — Orchestration Sync and Auth**
- Polling ingests new `NEEDS_GRADING` without duplicates
- Items in `ASSIGNED`/`IN_PROGRESS` are not reverted by polling
- Auth login and role-check work correctly
- Manual sync trigger works

**After Sprint 3 — Workflow Engine**
- FIFO ordering is correct per exam
- WIP limits are enforced
- Idempotency: duplicate assign and grade requests are safe
- Grade posts outcome back to Mock Intellum exactly once
- Unassign returns item to queue cleanly
- History is accurate and complete

**After Sprint 4 — Admin UI**
- Admin can assign, reassign, and unassign from the dashboard
- Filters work correctly
- Deep links open correctly for admin only

**After Sprint 5 — Grader UI**
- Grader sees only assigned work
- Start and grade flow completes successfully
- Double-action safety is observable in the UI

**After Sprint 6 — End-to-End**
- Full lifecycle: sync → assign → start → grade → history is stable
- Environment reset works
- Cloudflare deployment is validated

---

## Definition of Done

The implementation is demo-ready when all of the following are true:

- Polling imports ~100 `NEEDS_GRADING` submissions from Mock Intellum
- Polling never reverts items already in `ASSIGNED` or `IN_PROGRESS` state
- Admin sees FIFO queues by exam with assign, reassign, and unassign actions
- Grader WIP capacity of 2 is enforced
- Graders see only their own work
- Graders can start and submit `PASS` or `FAIL`
- Orchestration posts outcomes back to Mock Intellum exactly once (idempotent)
- Admin deep links open read-only submission detail pages
- History shows full lifecycle: assign, start, grade, reassign, unassign events
- Duplicate actions (double-click, concurrent admin) are handled safely
- Cloudflare Cron Trigger-compatible polling structure is in place
