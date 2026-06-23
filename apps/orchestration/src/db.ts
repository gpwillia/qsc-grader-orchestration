import { Pool } from 'pg';
import type { AuthUser, Submission, AssignmentState } from '@qsc/contracts';

export interface SyncStats {
  fetched: number;
  upserted: number;
  skippedLocked: number;
  lastWatermark: string;
}

export class OrchestrationStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrateAndSeedUsers(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'GRADER')),
        grader_capacity INTEGER NOT NULL DEFAULT 2,
        password TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS submissions_cache (
        submission_id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        learner_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        intellum_status TEXT NOT NULL,
        orchestration_state TEXT CHECK (orchestration_state IN ('ASSIGNED', 'IN_PROGRESS')),
        created_at TIMESTAMPTZ NOT NULL,
        source_last_updated TIMESTAMPTZ NOT NULL,
        last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        graded_result TEXT CHECK (graded_result IN ('PASS', 'FAIL'))
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id BIGSERIAL PRIMARY KEY,
        submission_id TEXT NOT NULL,
        grader_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL CHECK (state IN ('ASSIGNED', 'IN_PROGRESS', 'GRADED')),
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        assigned_by TEXT NOT NULL REFERENCES users(id),
        CONSTRAINT assignments_submission_unique UNIQUE (submission_id)
      );

      CREATE INDEX IF NOT EXISTS idx_assignments_grader_state
      ON assignments(grader_id, state);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_active_submission_unique
      ON assignments(submission_id)
      WHERE state IN ('ASSIGNED', 'IN_PROGRESS');

      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        submission_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_events_submission
      ON events(submission_id, timestamp);

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const users: Array<AuthUser & { password: string }> = [
      {
        id: 'u-admin-1',
        email: 'admin@qsc.demo',
        role: 'ADMIN',
        graderCapacity: 2,
        password: 'admin'
      },
      {
        id: 'u-admin-2',
        email: 'nathan@qsc.demo',
        role: 'ADMIN',
        graderCapacity: 2,
        password: 'admin'
      },
      {
        id: 'u-grader-1',
        email: 'grader1@qsc.demo',
        role: 'GRADER',
        graderCapacity: 2,
        password: 'grader'
      },
      {
        id: 'u-grader-2',
        email: 'grader2@qsc.demo',
        role: 'GRADER',
        graderCapacity: 2,
        password: 'grader'
      },
      {
        id: 'u-grader-3',
        email: 'grader3@qsc.demo',
        role: 'GRADER',
        graderCapacity: 2,
        password: 'grader'
      }
    ];

    for (const user of users) {
      await this.pool.query(
        `
          INSERT INTO users (id, email, role, grader_capacity, password)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO UPDATE
          SET email = EXCLUDED.email,
              role = EXCLUDED.role,
              grader_capacity = EXCLUDED.grader_capacity,
              password = EXCLUDED.password
        `,
        [user.id, user.email, user.role, user.graderCapacity, user.password]
      );
    }

    await this.pool.query(
      `
        INSERT INTO sync_state (key, value)
        VALUES ('last_needs_grading_sync_at', '1970-01-01T00:00:00.000Z')
        ON CONFLICT (key) DO NOTHING
      `
    );
  }

  async getUserByEmail(email: string): Promise<(AuthUser & { password: string }) | null> {
    const result = await this.pool.query(
      `
        SELECT id, email, role, grader_capacity, password
        FROM users
        WHERE email = $1
      `,
      [email]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      graderCapacity: Number(row.grader_capacity),
      password: row.password
    };
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    const result = await this.pool.query(
      `
        SELECT id, email, role, grader_capacity
        FROM users
        WHERE id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      graderCapacity: Number(row.grader_capacity)
    };
  }

  async listGraders(): Promise<AuthUser[]> {
    const result = await this.pool.query(
      `
        SELECT id, email, role, grader_capacity
        FROM users
        WHERE role = 'GRADER'
        ORDER BY email ASC
      `
    );

    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      graderCapacity: Number(row.grader_capacity)
    }));
  }

  async getSyncWatermark(): Promise<string> {
    const result = await this.pool.query(
      `
        SELECT value
        FROM sync_state
        WHERE key = 'last_needs_grading_sync_at'
      `
    );

    return result.rows[0]?.value ?? '1970-01-01T00:00:00.000Z';
  }

  async setSyncWatermark(value: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE sync_state
        SET value = $1,
            updated_at = NOW()
        WHERE key = 'last_needs_grading_sync_at'
      `,
      [value]
    );
  }

  async syncNeedsGradingSubmissions(submissions: Submission[]): Promise<SyncStats> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const watermarkResult = await client.query(
        `
          SELECT value
          FROM sync_state
          WHERE key = 'last_needs_grading_sync_at'
          FOR UPDATE
        `
      );
      const currentWatermark =
        watermarkResult.rows[0]?.value ?? '1970-01-01T00:00:00.000Z';

      let upserted = 0;
      let skippedLocked = 0;
      let maxWatermark = currentWatermark;

      for (const submission of submissions) {
        if (new Date(submission.lastUpdated).getTime() > new Date(maxWatermark).getTime()) {
          maxWatermark = submission.lastUpdated;
        }

        const existing = await client.query(
          `
            SELECT orchestration_state
            FROM submissions_cache
            WHERE submission_id = $1
          `,
          [submission.id]
        );

        const orchestrationState = existing.rows[0]?.orchestration_state ?? null;

        // Polling safety rule: never let Intellum NEEDS_GRADING overwrite in-flight orchestration states.
        if (orchestrationState === 'ASSIGNED' || orchestrationState === 'IN_PROGRESS') {
          skippedLocked += 1;
          continue;
        }

        await client.query(
          `
            INSERT INTO submissions_cache (
              submission_id,
              exam_id,
              learner_id,
              attempt_id,
              intellum_status,
              orchestration_state,
              created_at,
              source_last_updated,
              last_synced_at
            ) VALUES (
              $1, $2, $3, $4, 'NEEDS_GRADING', NULL, $5::timestamptz, $6::timestamptz, NOW()
            )
            ON CONFLICT (submission_id)
            DO UPDATE SET
              exam_id = EXCLUDED.exam_id,
              learner_id = EXCLUDED.learner_id,
              attempt_id = EXCLUDED.attempt_id,
              intellum_status = EXCLUDED.intellum_status,
              created_at = EXCLUDED.created_at,
              source_last_updated = EXCLUDED.source_last_updated,
              last_synced_at = NOW()
          `,
          [
            submission.id,
            submission.examId,
            submission.learnerId,
            submission.attemptId,
            submission.createdAt,
            submission.lastUpdated
          ]
        );

        await client.query(
          `
            INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
            VALUES ($1, 'SYNCED', 'system-sync', NOW(), $2::jsonb)
          `,
          [
            submission.id,
            JSON.stringify({
              intellumStatus: 'NEEDS_GRADING',
              sourceLastUpdated: submission.lastUpdated
            })
          ]
        );

        upserted += 1;
      }

      await client.query(
        `
          UPDATE sync_state
          SET value = $1,
              updated_at = NOW()
          WHERE key = 'last_needs_grading_sync_at'
        `,
        [maxWatermark]
      );

      await client.query('COMMIT');

      return {
        fetched: submissions.length,
        upserted,
        skippedLocked,
        lastWatermark: maxWatermark
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getHealthSummary(): Promise<{
    users: number;
    cachedSubmissions: number;
    assigned: number;
    inProgress: number;
    lastSyncAt: string | null;
    watermark: string;
  }> {
    const [users, cached, assigned, inProgress, lastSyncAt, watermark] = await Promise.all([
      this.pool.query('SELECT COUNT(*) AS total FROM users'),
      this.pool.query('SELECT COUNT(*) AS total FROM submissions_cache'),
      this.pool.query(
        "SELECT COUNT(*) AS total FROM submissions_cache WHERE orchestration_state = 'ASSIGNED'"
      ),
      this.pool.query(
        "SELECT COUNT(*) AS total FROM submissions_cache WHERE orchestration_state = 'IN_PROGRESS'"
      ),
      this.pool.query(
        "SELECT MAX(timestamp) AS value FROM events WHERE type = 'SYNCED'"
      ),
      this.getSyncWatermark()
    ]);

    return {
      users: Number(users.rows[0].total),
      cachedSubmissions: Number(cached.rows[0].total),
      assigned: Number(assigned.rows[0].total),
      inProgress: Number(inProgress.rows[0].total),
      lastSyncAt: lastSyncAt.rows[0].value ?? null,
      watermark
    };
  }

  async recordEvent(
    submissionId: string,
    type: string,
    actorId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
        VALUES ($1, $2, $3, NOW(), $4::jsonb)
      `,
      [submissionId, type, actorId, JSON.stringify(payload)]
    );
  }

  async getExamQueue(examId: string) {
    const result = await this.pool.query(
      `
        SELECT
          sc.submission_id, sc.exam_id, sc.learner_id, sc.attempt_id,
          sc.created_at, sc.intellum_status, sc.orchestration_state,
          a.id AS assignment_id, a.grader_id, a.assigned_at, a.assigned_by
        FROM submissions_cache sc
        LEFT JOIN assignments a ON sc.submission_id = a.submission_id
        WHERE sc.exam_id = $1
          AND sc.orchestration_state IS NULL
          AND sc.intellum_status = 'NEEDS_GRADING'
          AND sc.graded_result IS NULL
        ORDER BY sc.created_at ASC
      `,
      [examId]
    );

    return result.rows.map((row) => {
      const item: any = {
        submission: {
          id: row.submission_id,
          learnerId: row.learner_id,
          examId: row.exam_id,
          attemptId: row.attempt_id,
          createdAt: row.created_at,
          status: row.intellum_status,
          lastUpdated: row.created_at
        },
        assignment: null,
        examId: row.exam_id,
        learnerId: row.learner_id,
        attemptId: row.attempt_id
      };

      if (row.grader_id && row.state) {
        item.assignment = {
          submissionId: row.submission_id,
          graderId: row.grader_id,
          state: row.state as AssignmentState,
          assignedAt: row.assigned_at,
          assignedBy: row.assigned_by
        };
        item.assignedAt = row.assigned_at;
        item.assignedBy = row.assigned_by;
      }

      return item;
    });
  }

  async getGraderQueue(graderId: string) {
    const result = await this.pool.query(
      `
        SELECT
          sc.submission_id, sc.exam_id, sc.learner_id, sc.attempt_id,
          sc.created_at, sc.intellum_status, sc.orchestration_state,
          a.id AS assignment_id, a.state, a.assigned_at
        FROM submissions_cache sc
        INNER JOIN assignments a ON sc.submission_id = a.submission_id
        WHERE a.grader_id = $1 AND a.state IN ('ASSIGNED', 'IN_PROGRESS')
        ORDER BY a.assigned_at ASC
      `,
      [graderId]
    );

    return result.rows.map((row) => ({
      submission: {
        id: row.submission_id,
        learnerId: row.learner_id,
        examId: row.exam_id,
        attemptId: row.attempt_id,
        createdAt: row.created_at,
        status: row.intellum_status,
        lastUpdated: row.created_at
      },
      assignment: {
        submissionId: row.submission_id,
        graderId: graderId,
        state: row.state as AssignmentState,
        assignedAt: row.assigned_at,
        assignedBy: ''
      },
      examId: row.exam_id,
      learnerId: row.learner_id,
      attemptId: row.attempt_id
    }));
  }

  async getGraderActiveCount(graderId: string): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT COUNT(*) AS total
        FROM assignments
        WHERE grader_id = $1 AND state IN ('ASSIGNED', 'IN_PROGRESS')
      `,
      [graderId]
    );

    return Number(result.rows[0].total);
  }

  async assignSubmission(
    submissionId: string,
    graderId: string,
    assignedBy: string
  ): Promise<{ inserted: boolean; existingAssignmentId: number | null }> {
    try {
      const existingAssignment = await this.pool.query(
        `
          SELECT id, grader_id, state
          FROM assignments
          WHERE submission_id = $1
        `,
        [submissionId]
      );

      const currentAssignment = existingAssignment.rows[0];
      if (
        currentAssignment &&
        currentAssignment.grader_id === graderId &&
        (currentAssignment.state === 'ASSIGNED' || currentAssignment.state === 'IN_PROGRESS')
      ) {
        return {
          inserted: false,
          existingAssignmentId: Number(currentAssignment.id)
        };
      }

      const result = await this.pool.query(
        `
          INSERT INTO assignments (submission_id, grader_id, state, assigned_by)
          VALUES ($1, $2, 'ASSIGNED', $3)
          ON CONFLICT (submission_id) DO UPDATE
          SET grader_id = EXCLUDED.grader_id,
              assigned_by = EXCLUDED.assigned_by
          WHERE assignments.state IN ('ASSIGNED', 'IN_PROGRESS')
          RETURNING id
        `,
        [submissionId, graderId, assignedBy]
      );

      if (result.rowCount === 0) {
        const existing = await this.pool.query(
          `
            SELECT id
            FROM assignments
            WHERE submission_id = $1 AND state IN ('ASSIGNED', 'IN_PROGRESS')
          `,
          [submissionId]
        );

        return {
          inserted: false,
          existingAssignmentId: existing.rows[0]?.id ?? null
        };
      }

      await this.pool.query(
        `
          INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
          VALUES ($1, 'ASSIGNED', $2, NOW(), $3::jsonb)
        `,
        [submissionId, assignedBy, JSON.stringify({ graderId })]
      );

      await this.pool.query(
        `
          UPDATE submissions_cache
          SET orchestration_state = 'ASSIGNED'
          WHERE submission_id = $1
        `,
        [submissionId]
      );

      return {
        inserted: true,
        existingAssignmentId: Number(result.rows[0].id)
      };
    } catch (error) {
      if (String(error).includes('unique constraint')) {
        const existing = await this.pool.query(
          `
            SELECT id
            FROM assignments
            WHERE submission_id = $1 AND state IN ('ASSIGNED', 'IN_PROGRESS')
          `,
          [submissionId]
        );

        return {
          inserted: false,
          existingAssignmentId: existing.rows[0]?.id ?? null
        };
      }

      throw error;
    }
  }

  async transitionAssignmentState(
    submissionId: string,
    graderId: string,
    fromState: string,
    toState: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE assignments
        SET state = $1
        WHERE submission_id = $2 AND grader_id = $3 AND state = $4
        RETURNING id
      `,
      [toState, submissionId, graderId, fromState]
    );

    if (result.rowCount === 0) {
      return false;
    }

    await this.pool.query(
      `
        INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
        VALUES ($1, 'STARTED', $2, NOW(), $3::jsonb)
      `,
      [submissionId, graderId, JSON.stringify({ newState: toState })]
    );

    await this.pool.query(
      `
        UPDATE submissions_cache
        SET orchestration_state = $1
        WHERE submission_id = $2
      `,
      [toState, submissionId]
    );

    return true;
  }

  async getSubmissionGradingStatus(
    submissionId: string
  ): Promise<{ alreadyGraded: boolean; gradedResult?: 'PASS' | 'FAIL' }> {
    const result = await this.pool.query(
      `
        SELECT graded_result
        FROM submissions_cache
        WHERE submission_id = $1
      `,
      [submissionId]
    );

    if (result.rowCount === 0) {
      return { alreadyGraded: false };
    }

    const gradedResult = result.rows[0].graded_result;
    return {
      alreadyGraded: gradedResult !== null,
      gradedResult: gradedResult ?? undefined
    };
  }

  async gradeSubmission(
    submissionId: string,
    graderId: string,
    result: 'PASS' | 'FAIL'
  ): Promise<boolean> {
    const updateResult = await this.pool.query(
      `
        UPDATE assignments
        SET state = 'GRADED'
        WHERE submission_id = $1 AND grader_id = $2
        RETURNING id
      `,
      [submissionId, graderId]
    );

    if (updateResult.rowCount === 0) {
      return false;
    }

    await this.pool.query(
      `
        UPDATE submissions_cache
        SET graded_result = $1,
            intellum_status = $2,
            orchestration_state = NULL,
            source_last_updated = NOW()
        WHERE submission_id = $3
      `,
      [result, result === 'PASS' ? 'GRADED_PASS' : 'GRADED_FAIL', submissionId]
    );

    await this.pool.query(
      `
        INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
        VALUES ($1, 'GRADED', $2, NOW(), $3::jsonb)
      `,
      [submissionId, graderId, JSON.stringify({ result })]
    );

    return true;
  }

  async getGraderRecentGraded(graderId: string, limit = 20): Promise<Array<{
    submissionId: string;
    examId: string;
    learnerId: string;
    result: 'PASS' | 'FAIL' | null;
    gradedAt: string;
  }>> {
    const result = await this.pool.query(
      `
        SELECT
          a.submission_id,
          sc.exam_id,
          sc.learner_id,
          sc.graded_result,
          MAX(e.timestamp) AS graded_at
        FROM assignments a
        INNER JOIN submissions_cache sc ON sc.submission_id = a.submission_id
        INNER JOIN events e ON e.submission_id = a.submission_id AND e.type = 'GRADED'
        WHERE a.grader_id = $1
          AND a.state = 'GRADED'
        GROUP BY a.submission_id, sc.exam_id, sc.learner_id, sc.graded_result
        ORDER BY graded_at DESC
        LIMIT $2
      `,
      [graderId, limit]
    );

    return result.rows.map((row) => ({
      submissionId: row.submission_id,
      examId: row.exam_id,
      learnerId: row.learner_id,
      result: row.graded_result,
      gradedAt: row.graded_at
    }));
  }

  async reassignSubmission(
    submissionId: string,
    newGraderId: string,
    adminId: string
  ): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE assignments
        SET grader_id = $1, assigned_by = $2, state = 'ASSIGNED'
        WHERE submission_id = $3
        RETURNING id
      `,
      [newGraderId, adminId, submissionId]
    );

    if (result.rowCount === 0) {
      return 0;
    }

    await this.pool.query(
      `
        INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
        VALUES ($1, 'REASSIGNED', $2, NOW(), $3::jsonb)
      `,
      [submissionId, adminId, JSON.stringify({ newGraderId })]
    );

    return Number(result.rows[0].id);
  }

  async unassignSubmission(submissionId: string, adminId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        DELETE FROM assignments
        WHERE submission_id = $1
        RETURNING submission_id
      `,
      [submissionId]
    );

    if (result.rowCount === 0) {
      return false;
    }

    await this.pool.query(
      `
        UPDATE submissions_cache
        SET orchestration_state = NULL
        WHERE submission_id = $1
      `,
      [submissionId]
    );

    await this.pool.query(
      `
        INSERT INTO events (submission_id, type, actor_id, timestamp, payload)
        VALUES ($1, 'UNASSIGNED_BY_ADMIN', $2, NOW(), $3::jsonb)
      `,
      [submissionId, adminId, JSON.stringify({})]
    );

    return true;
  }

  async getSubmissionHistory(submissionId: string) {
    const result = await this.pool.query(
      `
        SELECT id, submission_id, type, actor_id, timestamp, payload
        FROM events
        WHERE submission_id = $1
        ORDER BY timestamp ASC
      `,
      [submissionId]
    );

    return result.rows.map((row) => ({
      eventId: String(row.id),
      submissionId: row.submission_id,
      type: row.type,
      actorId: row.actor_id,
      timestamp: row.timestamp,
      payload: row.payload
    }));
  }
}
