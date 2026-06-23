import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GradeResult, Submission, SubmissionStatus } from '@qsc/contracts';

interface SubmissionRow {
  id: string;
  learner_id: string;
  exam_id: string;
  attempt_id: string;
  created_at: string;
  status: SubmissionStatus;
  last_updated: string;
  graded_by: string | null;
  graded_at: string | null;
  grade_result: GradeResult | null;
}

interface SubmissionDetailRow {
  submission_id: string;
  metadata_json: string;
  artifact_url: string | null;
}

export interface SubmissionWithDetail {
  submission: Submission;
  detail: {
    metadata: Record<string, unknown>;
    artifactUrl: string | null;
    gradedBy: string | null;
    gradedAt: string | null;
    gradeResult: GradeResult | null;
  };
}

export interface GradePayload {
  result: GradeResult;
  graded_by: string;
  graded_at: string;
}

export class MockIntellumStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
    this.seedIfEmpty();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        exam_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        graded_by TEXT,
        graded_at TEXT,
        grade_result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_status_updated
      ON submissions(status, last_updated);

      CREATE TABLE IF NOT EXISTS submission_details (
        submission_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        artifact_url TEXT,
        FOREIGN KEY(submission_id) REFERENCES submissions(id)
      );
    `);
  }

  private seedIfEmpty(): void {
    const count = this.db
      .prepare('SELECT COUNT(*) AS total FROM submissions')
      .get() as { total: number };

    if (count.total > 0) {
      return;
    }

    const examIds = ['EXAM-AUDIO-101', 'EXAM-CONTROL-201', 'EXAM-DSP-301', 'EXAM-VIDEO-401'];
    const nowMs = Date.now();

    const insertSubmission = this.db.prepare(`
      INSERT INTO submissions (
        id, learner_id, exam_id, attempt_id, created_at, status, last_updated,
        graded_by, graded_at, grade_result
      ) VALUES (
        @id, @learner_id, @exam_id, @attempt_id, @created_at, @status, @last_updated,
        @graded_by, @graded_at, @grade_result
      )
    `);

    const insertDetail = this.db.prepare(`
      INSERT INTO submission_details (submission_id, metadata_json, artifact_url)
      VALUES (@submission_id, @metadata_json, @artifact_url)
    `);

    this.db.exec('BEGIN');
    try {
      let sequence = 1;

      // Seed 100 active submissions distributed across exams.
      for (let i = 0; i < 100; i += 1) {
        const learnerIndex = (i % 40) + 1;
        const examId = examIds[i % examIds.length];
        const createdAt = new Date(nowMs - i * 60_000).toISOString();

        insertSubmission.run({
          id: `sub-${sequence.toString().padStart(4, '0')}`,
          learner_id: `learner-${learnerIndex.toString().padStart(3, '0')}`,
          exam_id: examId,
          attempt_id: 'attempt-1',
          created_at: createdAt,
          status: 'NEEDS_GRADING',
          last_updated: createdAt,
          graded_by: null,
          graded_at: null,
          grade_result: null
        });

        insertDetail.run({
          submission_id: `sub-${sequence.toString().padStart(4, '0')}`,
          metadata_json: JSON.stringify({
            title: `Submission ${sequence}`,
            rubricVersion: '2026.1',
            program: 'QSC Certification',
            examId
          }),
          artifact_url: `https://mock-intellum.local/artifacts/sub-${sequence
            .toString()
            .padStart(4, '0')}`
        });

        sequence += 1;
      }

      // Seed retakes for realistic learner+exam attempt history.
      for (let j = 0; j < 12; j += 1) {
        const learnerId = `learner-${(j + 1).toString().padStart(3, '0')}`;
        const examId = examIds[j % examIds.length];
        const createdAt = new Date(nowMs - (100 + j) * 60_000).toISOString();

        insertSubmission.run({
          id: `sub-${sequence.toString().padStart(4, '0')}`,
          learner_id: learnerId,
          exam_id: examId,
          attempt_id: 'attempt-2',
          created_at: createdAt,
          status: 'NEEDS_GRADING',
          last_updated: createdAt,
          graded_by: null,
          graded_at: null,
          grade_result: null
        });

        insertDetail.run({
          submission_id: `sub-${sequence.toString().padStart(4, '0')}`,
          metadata_json: JSON.stringify({
            title: `Retake Submission ${sequence}`,
            rubricVersion: '2026.1',
            program: 'QSC Certification',
            examId,
            retake: true
          }),
          artifact_url: `https://mock-intellum.local/artifacts/sub-${sequence
            .toString()
            .padStart(4, '0')}`
        });

        sequence += 1;
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private toSubmission(row: SubmissionRow): Submission {
    return {
      id: row.id,
      learnerId: row.learner_id,
      examId: row.exam_id,
      attemptId: row.attempt_id,
      createdAt: row.created_at,
      status: row.status,
      lastUpdated: row.last_updated
    };
  }

  getSubmissions(status: SubmissionStatus, since?: string): Submission[] {
    const params: Record<string, string> = { status };
    let sql = `
      SELECT id, learner_id, exam_id, attempt_id, created_at, status, last_updated,
             graded_by, graded_at, grade_result
      FROM submissions
      WHERE status = @status
    `;

    if (since) {
      sql += ' AND last_updated > @since';
      params.since = since;
    }

    sql += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(sql).all(params) as unknown as SubmissionRow[];
    return rows.map((row) => this.toSubmission(row));
  }

  getSubmissionById(submissionId: string): SubmissionWithDetail | null {
    const row = this.db
      .prepare(
        `
        SELECT id, learner_id, exam_id, attempt_id, created_at, status, last_updated,
               graded_by, graded_at, grade_result
        FROM submissions
        WHERE id = ?
      `
      )
      .get(submissionId) as SubmissionRow | undefined;

    if (!row) {
      return null;
    }

    const detail = this.db
      .prepare(
        `
        SELECT submission_id, metadata_json, artifact_url
        FROM submission_details
        WHERE submission_id = ?
      `
      )
      .get(submissionId) as SubmissionDetailRow | undefined;

    return {
      submission: this.toSubmission(row),
      detail: {
        metadata: detail ? (JSON.parse(detail.metadata_json) as Record<string, unknown>) : {},
        artifactUrl: detail?.artifact_url ?? null,
        gradedBy: row.graded_by,
        gradedAt: row.graded_at,
        gradeResult: row.grade_result
      }
    };
  }

  gradeSubmission(submissionId: string, payload: GradePayload): SubmissionWithDetail | null {
    const status: SubmissionStatus = payload.result === 'PASS' ? 'GRADED_PASS' : 'GRADED_FAIL';

    const updated = this.db
      .prepare(
        `
        UPDATE submissions
        SET status = @status,
            graded_by = @graded_by,
            graded_at = @graded_at,
            grade_result = @grade_result,
            last_updated = @last_updated
        WHERE id = @id
      `
      )
      .run({
        id: submissionId,
        status,
        graded_by: payload.graded_by,
        graded_at: payload.graded_at,
        grade_result: payload.result,
        last_updated: payload.graded_at
      });

    if (updated.changes === 0) {
      return null;
    }

    return this.getSubmissionById(submissionId);
  }

  getSummary(): { total: number; needsGrading: number; graded: number } {
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM submissions').get() as {
      total: number;
    };

    const needsGrading = this.db
      .prepare("SELECT COUNT(*) AS total FROM submissions WHERE status = 'NEEDS_GRADING'")
      .get() as { total: number };

    const graded = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM submissions WHERE status IN ('GRADED_PASS', 'GRADED_FAIL')"
      )
      .get() as { total: number };

    return {
      total: total.total,
      needsGrading: needsGrading.total,
      graded: graded.total
    };
  }
}
