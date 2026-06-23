# Sprint 4 and 5 Smoke Validation

This script validates both Admin and Grader flows once local infrastructure is available.

## Infrastructure Prerequisite

If Docker is unavailable, this script cannot run because orchestration requires PostgreSQL.

Expected local stack:
- Postgres on localhost:5432
- Mock Intellum on localhost:8788
- Orchestration API on localhost:8789
- UI on localhost:5173

## Bring Up Stack

1. Start Docker Desktop, then:

   docker-compose up -d

2. Start services in separate shells:

   npm run dev:mock-intellum

   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/orchestration npm run dev:orchestration

   npm run dev:ui

## API Smoke Steps

1. Admin login:

   curl -s -X POST http://localhost:8789/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@qsc.demo","password":"admin"}'

2. Grader login:

   curl -s -X POST http://localhost:8789/api/auth/login -H "Content-Type: application/json" -d '{"email":"grader1@qsc.demo","password":"grader"}'

3. Admin manual sync:

   curl -s -X POST http://localhost:8789/api/sync -H "Authorization: Bearer <ADMIN_TOKEN>"

4. Admin fetch queue and assign one item:

   curl -s http://localhost:8789/api/exams/exam-001/queue -H "Authorization: Bearer <ADMIN_TOKEN>"

   curl -s -X POST http://localhost:8789/api/assignments -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{"submissionId":"sub-0001","graderId":"u-grader-1"}'

5. Grader queue should show item:

   curl -s http://localhost:8789/api/graders/u-grader-1/queue -H "Authorization: Bearer <GRADER_TOKEN>"

6. Grader start work:

   curl -s -X POST http://localhost:8789/api/assignments/sub-0001/start -H "Authorization: Bearer <GRADER_TOKEN>"

7. Grader submit PASS:

   curl -s -X POST http://localhost:8789/api/assignments/sub-0001/grade -H "Authorization: Bearer <GRADER_TOKEN>" -H "Content-Type: application/json" -d '{"result":"PASS"}'

8. Verify history:

   curl -s http://localhost:8789/api/submissions/sub-0001/history -H "Authorization: Bearer <ADMIN_TOKEN>"

## UI Smoke Steps

1. Open http://localhost:5173 and login as admin.
2. Click Manual Sync and verify unassigned queue appears.
3. Assign one submission to grader1.
4. Open a new browser session and login as grader1.
5. Verify My Queue shows the assigned item.
6. Verify Start Work is enabled only while ASSIGNED.
7. Click Start Work, then verify PASS and FAIL buttons become enabled.
8. Submit PASS and verify item is removed from grader active queue.
9. Back in admin session, verify active panel and history reflect the transition.

## Expected Outcomes

- Admin can assign, reassign, and unassign.
- Grader sees only personal queue.
- Grader cannot grade until item is IN_PROGRESS.
- PASS or FAIL completion removes item from active queue.
- History shows ASSIGNED, STARTED, and GRADED events in order.
