#!/usr/bin/env node

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:8789';
const EXAMS = ['EXAM-AUDIO-101', 'EXAM-CONTROL-201', 'EXAM-DSP-301', 'EXAM-VIDEO-401'];

function logStep(message) {
  console.log(`\n[smoke] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(path, options = {}, token) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {})
  };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

async function login(email, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  assert(data?.accessToken, `Login failed for ${email}`);
  return data;
}

async function run() {
  logStep('Checking health');
  const health = await api('/health');
  assert(health.ok, 'Health check did not return ok=true');
  console.log(`[ok] API reachable. cachedSubmissions=${health.cachedSubmissions}`);

  logStep('Authenticating users');
  const admin = await login('admin@qsc.demo', 'admin');
  console.log('[ok] Admin login');

  logStep('Running manual sync');
  const sync = await api('/api/sync', { method: 'POST' }, admin.accessToken);
  console.log(`[ok] Sync complete. fetched=${sync?.stats?.fetched ?? 0} upserted=${sync?.stats?.upserted ?? 0}`);

  logStep('Checking all exam queues');
  const totalsByExam = {};
  for (const examId of EXAMS) {
    const queue = await api(`/api/exams/${examId}/queue`, {}, admin.accessToken);
    totalsByExam[examId] = queue.total;
    console.log(`[ok] ${examId}: ${queue.total} unassigned`);
  }

  const targetExam = EXAMS.find((examId) => totalsByExam[examId] > 0);
  assert(targetExam, 'No unassigned submissions found in any exam queue');

  const targetQueue = await api(`/api/exams/${targetExam}/queue`, {}, admin.accessToken);
  const submissionId = targetQueue.items[0]?.submission?.id;
  assert(submissionId, `No submission found in ${targetExam} queue`);

  logStep('Selecting grader with available capacity');
  const gradersData = await api('/api/graders', {}, admin.accessToken);
  const graders = gradersData.graders ?? [];
  assert(graders.length > 0, 'No graders returned by /api/graders');

  let chosen = null;
  for (const grader of graders) {
    const queue = await api(`/api/graders/${grader.id}/queue`, {}, admin.accessToken);
    if (queue.activeCount < (queue.graderCapacity ?? 2)) {
      chosen = grader;
      break;
    }
  }

  if (!chosen) {
    const first = graders[0];
    const firstQueue = await api(`/api/graders/${first.id}/queue`, {}, admin.accessToken);
    const toUnassign = firstQueue.items[0]?.submission?.id;
    assert(toUnassign, 'All graders are full and no assignment available to unassign');

    await api(`/api/assignments/${toUnassign}/unassign`, { method: 'POST' }, admin.accessToken);
    console.log(`[ok] Freed capacity by unassigning ${toUnassign} from ${first.id}`);
    chosen = first;
  }

  logStep(`Assigning ${submissionId} to ${chosen.id}`);
  const assign = await api('/api/assignments', {
    method: 'POST',
    body: JSON.stringify({ submissionId, graderId: chosen.id })
  }, admin.accessToken);
  assert(assign.success === true, 'Assignment did not succeed');
  console.log(`[ok] Assigned ${submissionId} -> ${chosen.email}`);

  logStep('Grader starts and grades submission');
  const grader = await login(chosen.email, 'grader');
  const started = await api(`/api/assignments/${submissionId}/start`, { method: 'POST' }, grader.accessToken);
  assert(started.started === true, 'Start work did not return started=true');

  const graded = await api(`/api/assignments/${submissionId}/grade`, {
    method: 'POST',
    body: JSON.stringify({ result: 'PASS' })
  }, grader.accessToken);
  assert(graded.success === true, 'Grade did not return success=true');
  console.log(`[ok] Graded ${submissionId} PASS`);

  logStep('Validating audit history and grader recent history');
  const history = await api(`/api/submissions/${submissionId}/history`, {}, admin.accessToken);
  const eventTypes = (history.events ?? []).map((event) => event.type);
  assert(eventTypes.includes('ASSIGNED'), 'History missing ASSIGNED');
  assert(eventTypes.includes('STARTED'), 'History missing STARTED');
  assert(eventTypes.includes('GRADED'), 'History missing GRADED');
  assert(
    eventTypes.includes('GRADE_WRITEBACK_SUCCEEDED') || eventTypes.includes('GRADE_WRITEBACK_FAILED'),
    'History missing writeback event'
  );

  const recent = await api(`/api/graders/${chosen.id}/recent-graded?limit=20`, {}, grader.accessToken);
  const recentIds = (recent.items ?? []).map((item) => item.submissionId);
  assert(recentIds.includes(submissionId), 'Recent graded list does not include graded submission');

  console.log('\n[pass] Smoke test completed successfully');
  console.log(`[pass] submission=${submissionId} grader=${chosen.id} exam=${targetExam}`);
}

run().catch((error) => {
  console.error(`\n[fail] ${error.message}`);
  process.exit(1);
});
