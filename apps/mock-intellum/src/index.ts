import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { SubmissionStatus } from '@qsc/contracts';
import { MockIntellumStore } from './db.js';

const app = new Hono();
const dbPath = process.env.DB_PATH ?? './data/mock-intellum.db';
const adminToken = process.env.ADMIN_TOKEN;
const store = new MockIntellumStore(dbPath);

const gradeSchema = z.object({
  result: z.enum(['PASS', 'FAIL']),
  graded_by: z.string().min(1),
  graded_at: z.string().datetime({ offset: true })
});

function isAdminRequest(c: { req: { header: (name: string) => string | undefined; query: (key: string) => string | undefined } }): boolean {
  const roleHeader = c.req.header('x-user-role');
  const roleQuery = c.req.query('role');
  const token = c.req.header('x-admin-token');
  const roleAllowed = roleHeader === 'ADMIN' || roleQuery === 'ADMIN';

  if (!roleAllowed) {
    return false;
  }

  if (!adminToken) {
    return true;
  }

  return token === adminToken;
}

app.get('/health', (c) => {
  const summary = store.getSummary();

  return c.json({
    service: 'mock-intellum',
    ok: true,
    dbPath,
    seededSubmissions: summary.total,
    needsGrading: summary.needsGrading,
    graded: summary.graded
  });
});

app.get('/api/submissions', (c) => {
  const status = (c.req.query('status') ?? 'NEEDS_GRADING') as SubmissionStatus;
  const since = c.req.query('since');

  if (since && Number.isNaN(Date.parse(since))) {
    return c.json({ error: 'Invalid since timestamp. Use ISO-8601 format.' }, 400);
  }

  if (status !== 'NEEDS_GRADING' && status !== 'GRADED_PASS' && status !== 'GRADED_FAIL') {
    return c.json({ error: 'Unsupported status filter for Mock Intellum.' }, 400);
  }

  const submissions = store.getSubmissions(status, since);
  return c.json({ submissions, total: submissions.length });
});

app.get('/api/submissions/:id', (c) => {
  const submissionId = c.req.param('id');
  const record = store.getSubmissionById(submissionId);

  if (!record) {
    return c.json({ error: 'Submission not found' }, 404);
  }

  return c.json(record);
});

app.post('/api/submissions/:id/grade', zValidator('json', gradeSchema), (c) => {
  const submissionId = c.req.param('id');
  const payload = c.req.valid('json');

  const updated = store.gradeSubmission(submissionId, payload);
  if (!updated) {
    return c.json({ error: 'Submission not found' }, 404);
  }

  return c.json({
    submission: updated.submission,
    outcome: payload.result
  });
});

app.get('/admin/submissions/:id', (c) => {
  if (!isAdminRequest(c)) {
    return c.text('Forbidden: admin access required', 403);
  }

  const submissionId = c.req.param('id');
  const record = store.getSubmissionById(submissionId);

  if (!record) {
    return c.text('Submission not found', 404);
  }

  const { submission, detail } = record;
  const metadataRows = Object.entries(detail.metadata)
    .map(([key, value]) => `<li><strong>${key}</strong>: ${String(value)}</li>`)
    .join('');

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Mock Intellum Submission ${submission.id}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; }
          .grid { display: grid; grid-template-columns: 200px 1fr; gap: 0.5rem 1rem; max-width: 900px; }
          .label { color: #445; font-weight: 600; }
          .value { color: #111; }
        </style>
      </head>
      <body>
        <h1>Submission ${submission.id}</h1>
        <p>Read-only admin view (deep link target).</p>
        <div class="grid">
          <div class="label">Learner</div><div class="value">${submission.learnerId}</div>
          <div class="label">Exam</div><div class="value">${submission.examId}</div>
          <div class="label">Attempt</div><div class="value">${submission.attemptId}</div>
          <div class="label">Status</div><div class="value">${submission.status}</div>
          <div class="label">Created</div><div class="value">${submission.createdAt}</div>
          <div class="label">Last Updated</div><div class="value">${submission.lastUpdated}</div>
          <div class="label">Graded By</div><div class="value">${detail.gradedBy ?? '-'}</div>
          <div class="label">Graded At</div><div class="value">${detail.gradedAt ?? '-'}</div>
          <div class="label">Result</div><div class="value">${detail.gradeResult ?? '-'}</div>
          <div class="label">Artifact</div><div class="value">${detail.artifactUrl ?? '-'}</div>
        </div>
        <h2>Metadata</h2>
        <ul>${metadataRows}</ul>
      </body>
    </html>
  `;

  return c.html(html);
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port });
console.log(`mock-intellum listening on http://localhost:${port}`);
