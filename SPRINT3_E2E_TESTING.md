# Sprint 3: End-to-End Testing Guide

This document describes the complete testing workflow for Sprint 3 (Assignment Workflow Engine) with all endpoints validated against Mock Intellum and live Postgres.

## Prerequisites

1. **Postgres running locally:**
   ```bash
   docker-compose up -d
   ```

2. **Mock Intellum service running:**
   ```bash
   npm run dev:mock-intellum
   # Listens on http://localhost:8788
   ```

3. **Orchestration service running:**
   ```bash
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/orchestration" \
   npm run dev:orchestration
   # Listens on http://localhost:8789
   ```

4. **Test helper tools:**
   - `curl` for API calls
   - `jq` for JSON formatting (optional)
   - A text editor to store token responses

---

## Test Workflow

### Phase 1: Authentication

#### 1.1 Login as Admin
```bash
curl -X POST http://localhost:8789/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@qsc.demo","password":"admin"}' | jq
```

**Expected response:**
```json
{
  "accessToken": "<JWT_TOKEN>",
  "tokenType": "Bearer",
  "user": {
    "id": "u-admin-1",
    "email": "admin@qsc.demo",
    "role": "ADMIN",
    "graderCapacity": 2
  }
}
```

**Save:** Copy the `accessToken` value. Use as `$ADMIN_TOKEN` in subsequent requests.

#### 1.2 Login as Grader
```bash
curl -X POST http://localhost:8789/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"grader1@qsc.demo","password":"grader"}' | jq
```

**Save:** Copy the token as `$GRADER_TOKEN`.

#### 1.3 Verify /api/auth/me
```bash
curl -X GET http://localhost:8789/api/auth/me \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

**Expected:** User object with admin role.

---

### Phase 2: Polling & Queue Setup

#### 2.1 Trigger Manual Sync
```bash
curl -X POST http://localhost:8789/api/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

**Expected response:**
```json
{
  "skipped": false,
  "reason": "manual",
  "stats": {
    "fetched": 112,
    "upserted": 112,
    "skippedLocked": 0,
    "lastWatermark": "2025-01-15T..."
  }
}
```

#### 2.2 Check Health Summary
```bash
curl http://localhost:8789/health | jq
```

**Expected:**
- `cachedSubmissions`: 112
- `assigned`: 0 (no assignments yet)
- `inProgress`: 0

---

### Phase 3: Queue Inspection

#### 3.1 Get Exam Queue (Admin)
```bash
curl -X GET http://localhost:8789/api/exams/exam-001/queue \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

**Expected response:**
```json
{
  "items": [
    {
      "submission": {
        "id": "sub-0001",
        "learnerId": "learner-001",
        "examId": "exam-001",
        "attemptId": "attempt-001",
        "createdAt": "2025-01-15T00:00:00Z",
        "status": "NEEDS_GRADING",
        "lastUpdated": "2025-01-15T00:00:00Z"
      },
      "assignment": null,
      "examId": "exam-001",
      "learnerId": "learner-001",
      "attemptId": "attempt-001"
    }
    // ... more unassigned submissions
  ],
  "total": 28,
  "examId": "exam-001"
}
```

**Verify:**
- All items have `assignment: null` (no assignments yet)
- Items are ordered by `createdAt` (FIFO)

#### 3.2 Get Grader Queue (Empty at Start)
```bash
curl -X GET http://localhost:8789/api/graders/u-grader-1/queue \
  -H "Authorization: Bearer $GRADER_TOKEN" | jq
```

**Expected:**
```json
{
  "graderId": "u-grader-1",
  "items": [],
  "activeCount": 0,
  "graderCapacity": 2
}
```

---

### Phase 4: Assignment Workflow

#### 4.1 Assign Submission to Grader
```bash
curl -X POST http://localhost:8789/api/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "sub-0001",
    "graderId": "u-grader-1"
  }' | jq
```

**Expected response (HTTP 201):**
```json
{
  "submissionId": "sub-0001",
  "graderId": "u-grader-1",
  "isIdempotent": false,
  "success": true
}
```

**Verify:**
- Submission assignment record created
- Audit event `ASSIGNED` written to events table
- orchestration_state updated to `ASSIGNED`

#### 4.2 Test Idempotency: Assign Same Submission Again
```bash
curl -X POST http://localhost:8789/api/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "sub-0001",
    "graderId": "u-grader-1"
  }' | jq
```

**Expected response (HTTP 200):**
```json
{
  "submissionId": "sub-0001",
  "graderId": "u-grader-1",
  "isIdempotent": true,
  "success": true
}
```

**Verify:** Second call returns `isIdempotent: true` without creating duplicate event.

#### 4.3 Verify Grader Queue Updated
```bash
curl -X GET http://localhost:8789/api/graders/u-grader-1/queue \
  -H "Authorization: Bearer $GRADER_TOKEN" | jq '.items | length'
```

**Expected:** `1` item in grader's queue.

#### 4.4 Grader Starts Work
```bash
curl -X POST http://localhost:8789/api/assignments/sub-0001/start \
  -H "Authorization: Bearer $GRADER_TOKEN" | jq
```

**Expected response (HTTP 200):**
```json
{
  "submissionId": "sub-0001",
  "started": true
}
```

**Verify:**
- Assignment state changed to `IN_PROGRESS`
- Audit event `STARTED` recorded
- orchestration_state in cache updated to `IN_PROGRESS`

#### 4.5 Grader Submits Grade (PASS)
```bash
curl -X POST http://localhost:8789/api/assignments/sub-0001/grade \
  -H "Authorization: Bearer $GRADER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"result":"PASS"}' | jq
```

**Expected response (HTTP 201):**
```json
{
  "submissionId": "sub-0001",
  "outcome": "PASS",
  "isIdempotent": false,
  "success": true
}
```

**Verify:**
- Assignment state changed to `GRADED` (or removed)
- Audit event `GRADED` recorded
- graded_result in submissions_cache set to `PASS`

#### 4.6 Test Grade Idempotency
```bash
curl -X POST http://localhost:8789/api/assignments/sub-0001/grade \
  -H "Authorization: Bearer $GRADER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"result":"PASS"}' | jq
```

**Expected response (HTTP 200):**
```json
{
  "submissionId": "sub-0001",
  "outcome": "PASS",
  "isIdempotent": true,
  "success": true
}
```

**Verify:** Second grade with same result returns `isIdempotent: true`.

#### 4.7 Verify Grader Queue Cleared
```bash
curl -X GET http://localhost:8789/api/graders/u-grader-1/queue \
  -H "Authorization: Bearer $GRADER_TOKEN" | jq '.activeCount'
```

**Expected:** `0` (graded items removed from active queue).

---

### Phase 5: Reassignment & Unassign Workflows

#### 5.1 Assign New Submission
```bash
curl -X POST http://localhost:8789/api/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "sub-0002",
    "graderId": "u-grader-1"
  }' | jq
```

#### 5.2 Reassign to Different Grader (Admin)
```bash
curl -X POST http://localhost:8789/api/assignments/sub-0002/reassign \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"graderId":"u-grader-2"}' | jq
```

**Expected response:**
```json
{
  "submissionId": "sub-0002",
  "newGraderId": "u-grader-2",
  "success": true
}
```

**Verify:**
- Assignment grader_id changed to `u-grader-2`
- State reset to `ASSIGNED`
- Audit event `REASSIGNED` recorded with new grader

#### 5.3 Unassign Submission (Admin Override)
```bash
curl -X POST http://localhost:8789/api/assignments/sub-0002/unassign \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

**Expected response:**
```json
{
  "submissionId": "sub-0002",
  "unassigned": true,
  "success": true
}
```

**Verify:**
- Assignment record deleted
- orchestration_state reset to NULL
- Audit event `UNASSIGNED_BY_ADMIN` recorded

#### 5.4 Verify Item Returned to Exam Queue
```bash
curl -X GET http://localhost:8789/api/exams/exam-001/queue \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.items[] | select(.submission.id == "sub-0002")'
```

**Expected:** sub-0002 appears again with `assignment: null`.

---

### Phase 6: WIP Limit Enforcement

#### 6.1 Assign Multiple Items to Same Grader
```bash
for i in 3 4 5; do
  curl -X POST http://localhost:8789/api/assignments \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"submissionId\":\"sub-000$i\",\"graderId\":\"u-grader-3\"}" | jq '.success'
done
```

**Expected:** First two succeed (assignments 1 and 2), third fails with 400 error.

#### 6.2 Verify Third Assignment Fails
```bash
curl -X POST http://localhost:8789/api/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"submissionId":"sub-0005","graderId":"u-grader-3"}' | jq
```

**Expected response (HTTP 400):**
```json
{
  "error": "Grader has 2 active assignments (max 2)"
}
```

---

### Phase 7: Audit History

#### 7.1 Get Submission History
```bash
curl -X GET http://localhost:8789/api/submissions/sub-0001/history \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

**Expected response:**
```json
{
  "submissionId": "sub-0001",
  "events": [
    {
      "eventId": "1",
      "submissionId": "sub-0001",
      "type": "ASSIGNED",
      "actorId": "u-admin-1",
      "timestamp": "2025-01-15T10:00:00Z",
      "payload": {"graderId":"u-grader-1"}
    },
    {
      "eventId": "2",
      "submissionId": "sub-0001",
      "type": "STARTED",
      "actorId": "u-grader-1",
      "timestamp": "2025-01-15T10:05:00Z",
      "payload": {"newState":"IN_PROGRESS"}
    },
    {
      "eventId": "3",
      "submissionId": "sub-0001",
      "type": "GRADED",
      "actorId": "u-grader-1",
      "timestamp": "2025-01-15T10:15:00Z",
      "payload": {"result":"PASS"}
    }
  ]
}
```

**Verify:**
- All workflow events present in order
- Actor IDs correctly captured
- Timestamps are monotonically increasing

---

### Phase 8: WIP Cap Edge Cases

#### 8.1 Assign to Grader with Capacity = 0
Create a test grader with grader_capacity set to 0 (if needed):
```sql
INSERT INTO users (id, email, role, grader_capacity, password)
VALUES ('u-test-cap-0', 'test-cap-0@qsc.demo', 'GRADER', 0, 'test');
```

#### 8.2 Attempt Assignment (Should Fail)
```bash
curl -X POST http://localhost:8789/api/assignments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"submissionId":"sub-0100","graderId":"u-test-cap-0"}' | jq
```

**Expected:** Fails with capacity error.

---

## Verification Checklist

- [ ] All 8 authentication and basic endpoints work
- [ ] Exam queue returns unassigned items in FIFO order
- [ ] Grader queue shows only items assigned to that grader
- [ ] Assignment creation enforces WIP limit (max 2 active)
- [ ] Idempotency: second assignment POST returns existing record
- [ ] Idempotency: second grade POST with same result returns success
- [ ] State transitions validated (ASSIGNED → IN_PROGRESS → GRADED)
- [ ] Reassign changes grader and resets to ASSIGNED
- [ ] Unassign removes assignment and returns item to exam queue
- [ ] Unassign only works for admins
- [ ] Audit history complete and events in order
- [ ] No duplicate events created on idempotent calls

---

## Demo Reset Workflow

After a full test run, reset for next demo:

```bash
# Stop services
pkill -f 'dev:orchestration'
pkill -f 'dev:mock-intellum'

# Remove Postgres volume (if desired)
docker-compose down -v

# Restart fresh
docker-compose up -d
npm run dev:mock-intellum &
npm run dev:orchestration &
```

---

## Troubleshooting

### "Connection refused" on Postgres
- Ensure `docker-compose up -d` ran successfully
- Check `docker ps | grep postgres`

### Grader cannot see full queue
- Verify grader ID matches JWT token subject
- Check that assignments have state `ASSIGNED` or `IN_PROGRESS`

### Duplicate assignments created despite idempotency
- Check unique constraint on assignments table:
  ```sql
  SELECT constraint_name FROM information_schema.table_constraints
  WHERE table_name='assignments' AND constraint_type='UNIQUE';
  ```

### Grading twice produces two events
- Verify `graded_result` column exists on submissions_cache
- Check that grade endpoint queries existing state before insert

