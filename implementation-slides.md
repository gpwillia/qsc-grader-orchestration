# QSC Grader Orchestration — Implementation Plan
### SEI · Client-Facing Slide Content

---

## Slide 1: Implementation Approach

- Three-layer demo: Mock Intellum (system of record), Orchestration (workflow engine), QSC UI (operator experience)
- Strict build order: Mock Intellum → Orchestration → QSC UI
- Each layer is validated independently before the next begins
- Monorepo structure with shared contracts package and independent deploy pipelines per app
- Architecture decisions locked upfront to prevent rework when moving from local to Cloudflare

---

## Slide 2: Agreed Technical Direction

| Decision | Choice |
|---|---|
| Repo model | Monorepo with apps + packages/contracts |
| Shared contracts | packages/contracts consumed by all apps |
| Release model | Independent deploys per app, governed by contract compatibility |
| Contracts governance | Semantic versioning + changelog + consumer impact checks |
| Front end | React + Vite |
| Persistence (demo) | mock-intellum: SQLite, orchestration: managed Postgres |
| Authentication | JWT session auth |
| Sync model | Polling now; upgradeable to push/webhooks |
| Cloud polling mechanism | Cloudflare Cron Trigger (not a long-lived loop) |
| Workflow model | NEEDS_GRADING → ASSIGNED → IN_PROGRESS → GRADED |
| Assignment model | Manual; FIFO per exam; grader WIP limit of 2 |

---

## Slide 3: State Ownership Model

**Clear boundary between Intellum and Orchestration:**

| Status | Owned by | Notes |
|---|---|---|
| NEEDS_GRADING | Intellum | Source of truth for new submissions |
| ASSIGNED | Orchestration | Orchestration takes ownership on assignment |
| IN_PROGRESS | Orchestration | Grader has started work |
| GRADED (PASS/FAIL) | Intellum | Orchestration posts result; Intellum records outcome |

**Key rule:** polling only creates or updates records still in `NEEDS_GRADING` in Intellum.  
It never reverts an item already in `ASSIGNED` or `IN_PROGRESS` state in Orchestration — even if Intellum still shows `NEEDS_GRADING`.  
This prevents queue corruption and makes demo behavior predictable.

---

## Slide 4: Delivery Sequence

**Phase 1 — Foundation** (1–2 days)
- Monorepo scaffolding: apps + packages/contracts
- Shared TypeScript domain contracts package
- Independent build/deploy setup per app
- Contracts semver policy and changelog workflow
- Local environment setup
- Seeded demo users
- Deployment architecture decision: Cron Trigger, D1 vs Postgres

**Phase 2 — Mock Intellum** (3–5 days)
- Submissions list and detail endpoints
- Grade endpoint (pass/fail)
- Read-only admin detail page (deep-link target)
- ~100 seeded submissions across multiple exams and retakes
- ✓ Validation gate before proceeding

**Phase 3 — Orchestration** (2 weeks)
- Polling sync with Cloudflare Cron Trigger compatibility
- Assignment engine with WIP limits and FIFO ordering
- State transitions: assign, start, grade, reassign, unassign
- Idempotency and optimistic locking
- Audit trail and history
- ✓ Validation gate before proceeding

**Phase 4 — Admin UI** (1 week)
- Queue view by exam with filters
- Assign, reassign, unassign actions
- Deep links to Mock Intellum detail
- ✓ Validation gate before proceeding

**Phase 5 — Grader UI** (1 week)
- My Queue view
- Start work and pass/fail actions

**Phase 6 — Hardening** (3–5 days)
- Demo reset tooling
- Smoke tests
- Cloudflare deployment validation

---

## Slide 5: What Gets Built — Mock Intellum

**Purpose:** simulates the Intellum system of record for the demo.

Endpoints:
- `GET /api/submissions?status=NEEDS_GRADING&since=...` — filtered list for polling
- `GET /api/submissions/:id` — submission detail
- `POST /api/submissions/:id/grade` — accepts PASS/FAIL, updates record
- `GET /admin/submissions/:id` — read-only HTML (admin deep-link target)

Seed data:
- ~100 submissions across multiple exams
- Multiple learner attempts to demonstrate resubmission tracking

Validation gate:
- Submissions are listable and filterable
- Grade updates are reflected correctly
- Admin detail page is role-restricted

---

## Slide 6: What Gets Built — Orchestration Layer

**Purpose:** the workflow engine. Owns assignment, queueing, and business rules.

Key capabilities:
- Polling sync from Mock Intellum (Cron Trigger-compatible)
- Polling rule: never revert `ASSIGNED`/`IN_PROGRESS` items
- Manual sync trigger for admin and development use
- FIFO queue per exam
- Assignment with grader WIP limit enforcement (max 2 active)
- State transitions: assign → start → grade / reassign / unassign
- Grade callback to Mock Intellum (idempotent)
- Full audit trail via events table
- JWT auth with role enforcement

New in this design:
- **Idempotency + optimistic locking:** unique constraint on active assignment per submission; grade endpoint is safe to call twice
- **Admin unassign:** returns item to queue without a DB fix; audit event written

---

## Slide 7: What Gets Built — QSC UI

**Purpose:** the operator interface for admins and graders.

Admin experience:
- FIFO queue by exam
- Filters: exam, status, grader, age bucket
- Past-due indicator
- Assign and reassign actions
- **Unassign (return to queue)** — admin override for corrections and demo recovery
- Admin-only deep link to Mock Intellum submission detail

Grader experience:
- "My Queue" — assigned items only
- Start Work (`ASSIGNED → IN_PROGRESS`)
- Submit PASS or FAIL (`IN_PROGRESS → GRADED`)
- Clean empty and error states

---

## Slide 8: Idempotency and Concurrency Safety

**Why this matters:** in a real grading operation, admins double-click and concurrent users race. In a demo, a double-click that creates two events breaks credibility immediately.

What we build:
- Unique DB constraint on active assignment per submission (prevents two admins assigning simultaneously)
- Grade endpoint checks existing state before writing event or calling Mock Intellum
- Same grade request submitted twice: one event written, one Intellum update, clean response both times
- Unassign is safe to call twice: idempotent, no duplicate events

What this gives QSC:
- A credible, trustworthy audit trail
- Safe concurrent admin operation
- A foundation that holds up in production volume

---

## Slide 9: Deployment Architecture

**Cloudflare target stack:**

| Component | Cloudflare service |
|---|---|
| QSC UI | Cloudflare Pages |
| Mock Intellum API | Cloudflare Workers |
| Orchestration API | Cloudflare Workers |
| Polling job | Cloudflare Cron Trigger |
| Orchestration DB | Neon/Supabase Postgres |

Deployment model:
- apps/mock-intellum deploys independently
- apps/orchestration deploys independently
- apps/mock-qsc-ui deploys independently
- Contract compatibility is enforced through packages/contracts semver

**Key note on polling:**
Cloudflare Workers do not support long-lived background loops. The polling job is implemented as a Cron Trigger — a scheduled Worker invocation. Locally, this is replicated with a simple interval timer or manual `POST /api/sync`. The code path is identical; only the trigger mechanism differs.

DB decision is managed Postgres for orchestration and locked in Sprint 0 before polling implementation.

Contracts release discipline:
- MAJOR for breaking contract changes
- MINOR for additive backward-compatible changes
- PATCH for non-breaking contract fixes
- Each app pins or controls allowed contract version range

---

## Slide 10: Validation Gates

Each layer is verified before the next begins.

**Gate 1 — Mock Intellum**
- Submissions are listed, filtered, and graded correctly
- Retake records are distinguishable
- Admin detail page is role-restricted

**Gate 2 — Orchestration Sync and Auth**
- Polling ingests without duplicates
- `ASSIGNED`/`IN_PROGRESS` items are never reverted by polling
- Auth and role enforcement work correctly

**Gate 3 — Orchestration Workflow**
- FIFO ordering is correct
- WIP limits enforced
- Idempotency verified for assign and grade
- Unassign returns item to queue cleanly
- History is complete and accurate

**Gate 4 — Admin UI**
- Assign, reassign, and unassign work from the dashboard
- Deep links open for admin only

**Gate 5 — Grader UI**
- Grader sees only their own work
- Start and grade flow completes correctly
- Double-action safety is observable

**Gate 6 — End-to-End**
- Full lifecycle runs: sync → assign → start → grade → history
- Demo reset works
- Cloudflare deployment is validated

---

## Slide 11: Sprint Plan Overview

| Sprint | Focus | Duration |
|---|---|---|
| 0 | Setup, shared types, deployment ADR | 1–2 days |
| 1 | Mock Intellum API and seed data | 3–5 days |
| 2 | Orchestration schema, sync, auth | 1 week |
| 3 | Assignment workflow, idempotency, unassign, audit | 1 week |
| 4 | Admin UI | 1 week |
| 5 | Grader UI | 1 week |
| 6 | Hardening, Cloudflare deploy, demo readiness | 3–5 days |

**Estimated total: 4–6 weeks** for a focused small team.

---

## Slide 12: Definition of Done

The demo is ready when all of the following are true:

- Polling imports ~100 `NEEDS_GRADING` submissions from Mock Intellum
- Polling never reverts items already in `ASSIGNED` or `IN_PROGRESS`
- Admin sees FIFO queues by exam with assign, reassign, and unassign actions
- Grader WIP limit of 2 is enforced
- Graders see only their own work
- Graders can start and submit PASS or FAIL
- Orchestration posts outcomes to Mock Intellum exactly once (idempotent)
- Admin deep links open read-only submission detail
- Full event history: assign, start, grade, reassign, unassign
- Duplicate actions and concurrent requests are handled safely
- Cloudflare Cron Trigger-compatible polling is in place and deployed

---

## Slide 13: Immediate Next Steps

1. Scaffold monorepo apps and packages/contracts
2. Define semver policy and changelog workflow for contracts
3. Define shared domain model and API contracts in packages/contracts (Sprint 0)
4. Build and validate Mock Intellum with seed data (Sprint 1)
5. Implement orchestration polling with Cron Trigger-compatible structure (Sprint 2)
6. Build workflow engine with idempotency guards and admin unassign (Sprint 3)
7. Build admin and grader UI against stable APIs (Sprints 4–5)
8. Run end-to-end smoke test and prepare demo script (Sprint 6)
