import type { AssignmentState, QueueItem, HistoryRecord } from '@qsc/contracts';
import type { OrchestrationStore } from './db.js';

export interface AssignmentResult {
  success: boolean;
  isIdempotent: boolean;
  assignmentId: number;
  submissionId: string;
  graderId: string;
  detail?: string;
}

export interface UnassignResult {
  success: boolean;
  submissionId: string;
  detail?: string;
}

export interface StartWorkResult {
  success: boolean;
  submissionId: string;
  detail?: string;
}

export interface GradeResult {
  success: boolean;
  isIdempotent: boolean;
  submissionId: string;
  outcome: 'PASS' | 'FAIL';
  detail?: string;
}

export class AssignmentEngine {
  constructor(private store: OrchestrationStore) {}

  async getExamQueue(examId: string): Promise<QueueItem[]> {
    return this.store.getExamQueue(examId);
  }

  async getGraderQueue(graderId: string): Promise<QueueItem[]> {
    return this.store.getGraderQueue(graderId);
  }

  async getGraderActiveCount(graderId: string): Promise<number> {
    return this.store.getGraderActiveCount(graderId);
  }

  async assignSubmission(
    submissionId: string,
    graderId: string,
    assignedBy: string
  ): Promise<AssignmentResult> {
    // Check grader capacity first
    const activeCount = await this.getGraderActiveCount(graderId);
    if (activeCount >= 2) {
      return {
        success: false,
        isIdempotent: false,
        assignmentId: 0,
        submissionId,
        graderId,
        detail: `Grader has ${activeCount} active assignments (max 2)`
      };
    }

    try {
      const result = await this.store.assignSubmission(submissionId, graderId, assignedBy);
      return {
        success: result.inserted,
        isIdempotent: !result.inserted && result.existingAssignmentId !== null,
        assignmentId: result.existingAssignmentId ?? 0,
        submissionId,
        graderId
      };
    } catch (error) {
      return {
        success: false,
        isIdempotent: false,
        assignmentId: 0,
        submissionId,
        graderId,
        detail: String(error)
      };
    }
  }

  async startWork(submissionId: string, graderId: string): Promise<StartWorkResult> {
    try {
      const updated = await this.store.transitionAssignmentState(
        submissionId,
        graderId,
        'ASSIGNED',
        'IN_PROGRESS'
      );

      return {
        success: updated,
        submissionId,
        detail: updated ? 'Started' : 'Submission not found or not in ASSIGNED state'
      };
    } catch (error) {
      return {
        success: false,
        submissionId,
        detail: String(error)
      };
    }
  }

  async gradeSubmission(
    submissionId: string,
    graderId: string,
    result: 'PASS' | 'FAIL'
  ): Promise<GradeResult> {
    try {
      const existing = await this.store.getSubmissionGradingStatus(submissionId);

      // Idempotency: if already graded with same result, return success
      if (existing.alreadyGraded && existing.gradedResult === result) {
        return {
          success: true,
          isIdempotent: true,
          submissionId,
          outcome: result,
          detail: 'Already graded with same result'
        };
      }

      if (existing.alreadyGraded) {
        return {
          success: false,
          isIdempotent: false,
          submissionId,
          outcome: result,
          detail: `Submission already graded as ${existing.gradedResult}`
        };
      }

      const updated = await this.store.gradeSubmission(
        submissionId,
        graderId,
        result
      );

      return {
        success: updated,
        isIdempotent: false,
        submissionId,
        outcome: result
      };
    } catch (error) {
      return {
        success: false,
        isIdempotent: false,
        submissionId,
        outcome: result,
        detail: String(error)
      };
    }
  }

  async reassignSubmission(
    submissionId: string,
    newGraderId: string,
    adminId: string
  ): Promise<AssignmentResult> {
    try {
      const activeCount = await this.getGraderActiveCount(newGraderId);
      if (activeCount >= 2) {
        return {
          success: false,
          isIdempotent: false,
          assignmentId: 0,
          submissionId,
          graderId: newGraderId,
          detail: `Target grader has ${activeCount} active assignments (max 2)`
        };
      }

      const result = await this.store.reassignSubmission(
        submissionId,
        newGraderId,
        adminId
      );

      return {
        success: result > 0,
        isIdempotent: false,
        assignmentId: result,
        submissionId,
        graderId: newGraderId
      };
    } catch (error) {
      return {
        success: false,
        isIdempotent: false,
        assignmentId: 0,
        submissionId,
        graderId: newGraderId,
        detail: String(error)
      };
    }
  }

  async unassignSubmission(
    submissionId: string,
    adminId: string
  ): Promise<UnassignResult> {
    try {
      const result = await this.store.unassignSubmission(submissionId, adminId);

      return {
        success: result,
        submissionId,
        detail: result ? 'Unassigned and returned to queue' : 'Submission not found or not assigned'
      };
    } catch (error) {
      return {
        success: false,
        submissionId,
        detail: String(error)
      };
    }
  }

  async getSubmissionHistory(submissionId: string): Promise<HistoryRecord[]> {
    return this.store.getSubmissionHistory(submissionId);
  }
}
