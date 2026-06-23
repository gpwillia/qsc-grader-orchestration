import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AuthUser } from '@qsc/contracts';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { OrchestrationStore } from './db.js';
import { AssignmentEngine } from './assignments.js';
import { requireAdmin, requireAuth, signAccessToken } from './auth.js';
import { runNeedsGradingSync } from './sync.js';

type AppVariables = {
  authUser: AuthUser;
};

const app = new Hono<{ Variables: AppVariables }>();
app.use(
  '*',
  cors({
    // Dev/test mode: allow tunnel-hosted UI origins to call local API.
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS']
  })
);

const port = Number(process.env.PORT ?? 8789);
const intellumApiBaseUrl = process.env.INTELLUM_API_BASE_URL ?? 'http://localhost:8788';
const jwtSecret = process.env.JWT_SECRET ?? 'local-dev-secret-change-me';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN ?? '8h';
const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? 0);
const cronToken = process.env.CRON_TOKEN ?? '';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for orchestration service startup');
}

const store = new OrchestrationStore(process.env.DATABASE_URL);
const assignmentEngine = new AssignmentEngine(store);
await store.migrateAndSeedUsers();

let isPolling = false;

async function performSync(reason: 'manual' | 'cron' | 'interval') {
  if (isPolling) {
    return {
      skipped: true,
      reason,
      detail: 'Sync already in progress'
    };
  }

  isPolling = true;
  try {
    const stats = await runNeedsGradingSync(store, intellumApiBaseUrl);
    return {
      skipped: false,
      reason,
      stats
    };
  } finally {
    isPolling = false;
  }
}

if (pollIntervalSeconds > 0) {
  setInterval(() => {
    void performSync('interval').catch((error) => {
      console.error('[orchestration] interval sync error', error);
    });
  }, pollIntervalSeconds * 1000);
}

app.get('/', (c) => {
  return c.json({
    service: 'orchestration',
    ok: true,
    message: 'API is running. Use /health and /api/* endpoints.'
  });
});

app.get('/health', async (c) => {
  const summary = await store.getHealthSummary();

  return c.json({
    service: 'orchestration',
    ok: true,
    intellumApiBaseUrl,
    pollIntervalSeconds,
    dbConfigured: Boolean(process.env.DATABASE_URL),
    ...summary
  });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400);
  }

  const user = await store.getUserByEmail(body.email.toLowerCase().trim());
  if (!user || user.password !== body.password) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = signAccessToken(user, jwtSecret, jwtExpiresIn);

  return c.json({
    accessToken: token,
    tokenType: 'Bearer',
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      graderCapacity: user.graderCapacity
    }
  });
});

app.get('/api/auth/me', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const user = c.get('authUser');
  return c.json({ user });
});

app.post('/api/sync', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const adminError = requireAdmin(c);
  if (adminError) {
    return adminError;
  }

  try {
    const result = await performSync('manual');
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Sync failed', detail: String(error) }, 502);
  }
});

// Cron Trigger-compatible endpoint for cloud scheduler invocation.
app.post('/internal/poll', async (c) => {
  if (cronToken) {
    const token = c.req.header('x-cron-token');
    if (token !== cronToken) {
      return c.json({ error: 'Unauthorized cron token' }, 401);
    }
  }

  try {
    const result = await performSync('cron');
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Cron poll failed', detail: String(error) }, 502);
  }
});

app.get('/api/auth/demo-users', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const adminError = requireAdmin(c);
  if (adminError) {
    return adminError;
  }

  const health = await store.getHealthSummary();
  return c.json({
    credentialsHint: {
      admin: 'admin@qsc.demo / admin',
      grader: 'grader1@qsc.demo / grader'
    },
    usersSeeded: health.users
  });
});

app.get('/api/graders', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const adminError = requireAdmin(c);
  if (adminError) {
    return adminError;
  }

  try {
    const graders = await store.listGraders();
    return c.json({ graders, total: graders.length });
  } catch (error) {
    return c.json({ error: 'Failed to fetch graders', detail: String(error) }, 500);
  }
});

// Sprint 3: Queue APIs
app.get('/api/exams/:examId/queue', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const adminError = requireAdmin(c);
  if (adminError) {
    return adminError;
  }

  const examId = c.req.param('examId');
  try {
    const items = await assignmentEngine.getExamQueue(examId);
    return c.json({
      items,
      total: items.length,
      examId
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch exam queue', detail: String(error) }, 500);
  }
});

app.get('/api/graders/:graderId/queue', async (c, next) => requireAuth(c, next, store, jwtSecret), async (c) => {
  const graderId = c.req.param('graderId');
  const authUser = c.get('authUser');

  // Graders can only see their own queue; admins can see any
  if (authUser.role !== 'ADMIN' && authUser.id !== graderId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const items = await assignmentEngine.getGraderQueue(graderId);
    const activeCount = await assignmentEngine.getGraderActiveCount(graderId);
    const grader = await store.getUserById(graderId);

    return c.json({
      graderId,
      items,
      activeCount,
      graderCapacity: grader?.graderCapacity ?? 2
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch grader queue', detail: String(error) }, 500);
  }
});

// Sprint 3: Assignment Endpoints
app.post(
  '/api/assignments',
  zValidator('json', z.object({
    submissionId: z.string(),
    graderId: z.string()
  })),
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const adminError = requireAdmin(c);
    if (adminError) {
      return adminError;
    }

    const { submissionId, graderId } = c.req.valid('json');
    const admin = c.get('authUser');

    try {
      const result = await assignmentEngine.assignSubmission(submissionId, graderId, admin.id);

      if (!result.success && !result.isIdempotent) {
        return c.json({ error: result.detail ?? 'Failed to assign submission' }, 400);
      }

      return c.json({
        submissionId,
        graderId,
        isIdempotent: result.isIdempotent,
        success: true
      }, result.isIdempotent ? 200 : 201);
    } catch (error) {
      return c.json({ error: 'Assignment failed', detail: String(error) }, 500);
    }
  }
);

app.post(
  '/api/assignments/:submissionId/start',
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const submissionId = c.req.param('submissionId');
    const grader = c.get('authUser');

    try {
      const result = await assignmentEngine.startWork(submissionId, grader.id);

      if (!result.success) {
        return c.json({ error: result.detail ?? 'Failed to start work' }, 400);
      }

      return c.json({ submissionId, started: true });
    } catch (error) {
      return c.json({ error: 'Start work failed', detail: String(error) }, 500);
    }
  }
);

app.post(
  '/api/assignments/:submissionId/grade',
  zValidator('json', z.object({
    result: z.enum(['PASS', 'FAIL'])
  })),
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const submissionId = c.req.param('submissionId');
    const { result } = c.req.valid('json');
    const grader = c.get('authUser');

    try {
      const gradeResult = await assignmentEngine.gradeSubmission(submissionId, grader.id, result);

      if (!gradeResult.success) {
        return c.json({ error: gradeResult.detail ?? 'Failed to grade submission' }, 400);
      }

      return c.json({
        submissionId,
        outcome: result,
        isIdempotent: gradeResult.isIdempotent,
        success: true
      }, gradeResult.isIdempotent ? 200 : 201);
    } catch (error) {
      return c.json({ error: 'Grading failed', detail: String(error) }, 500);
    }
  }
);

app.post(
  '/api/assignments/:submissionId/reassign',
  zValidator('json', z.object({
    graderId: z.string()
  })),
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const adminError = requireAdmin(c);
    if (adminError) {
      return adminError;
    }

    const submissionId = c.req.param('submissionId');
    const { graderId } = c.req.valid('json');
    const admin = c.get('authUser');

    try {
      const result = await assignmentEngine.reassignSubmission(submissionId, graderId, admin.id);

      if (!result.success) {
        return c.json({ error: result.detail ?? 'Failed to reassign submission' }, 400);
      }

      return c.json({ submissionId, newGraderId: graderId, success: true });
    } catch (error) {
      return c.json({ error: 'Reassignment failed', detail: String(error) }, 500);
    }
  }
);

app.post(
  '/api/assignments/:submissionId/unassign',
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const adminError = requireAdmin(c);
    if (adminError) {
      return adminError;
    }

    const submissionId = c.req.param('submissionId');
    const admin = c.get('authUser');

    try {
      const result = await assignmentEngine.unassignSubmission(submissionId, admin.id);

      if (!result.success) {
        return c.json({ error: result.detail ?? 'Failed to unassign submission' }, 400);
      }

      return c.json({ submissionId, unassigned: true, success: true });
    } catch (error) {
      return c.json({ error: 'Unassignment failed', detail: String(error) }, 500);
    }
  }
);

// Sprint 3: History Endpoint
app.get(
  '/api/submissions/:submissionId/history',
  async (c, next) => requireAuth(c, next, store, jwtSecret),
  async (c) => {
    const submissionId = c.req.param('submissionId');

    try {
      const history = await assignmentEngine.getSubmissionHistory(submissionId);
      return c.json({
        submissionId,
        events: history
      });
    } catch (error) {
      return c.json({ error: 'Failed to fetch history', detail: String(error) }, 500);
    }
  }
);

serve({ fetch: app.fetch, port });
console.log(`orchestration listening on http://localhost:${port}`);
