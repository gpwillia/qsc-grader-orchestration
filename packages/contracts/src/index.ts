export type UserRole = 'ADMIN' | 'GRADER';

export type SubmissionStatus =
  | 'NEEDS_GRADING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'GRADED_PASS'
  | 'GRADED_FAIL';

export type AssignmentState = 'ASSIGNED' | 'IN_PROGRESS';

export type GradeResult = 'PASS' | 'FAIL';

export interface Submission {
  id: string;
  learnerId: string;
  examId: string;
  attemptId: string;
  createdAt: string;
  status: SubmissionStatus;
  lastUpdated: string;
}

export interface Assignment {
  submissionId: string;
  graderId: string;
  state: AssignmentState;
  assignedAt: string;
  assignedBy: string;
}

export interface GradeSubmissionRequest {
  result: GradeResult;
  gradedBy: string;
  gradedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  graderCapacity: number;
}

export interface AuditEvent {
  id: string;
  submissionId: string;
  type:
    | 'ASSIGNED'
    | 'STARTED'
    | 'GRADED'
    | 'REASSIGNED'
    | 'UNASSIGNED_BY_ADMIN'
    | 'SYNCED';
  actorId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface QueueItem {
  submission: Submission;
  assignment: Assignment | null;
  examId: string;
  learnerId: string;
  attemptId: string;
  assignedAt?: string;
  assignedBy?: string;
}

export interface AssignmentRequest {
  submissionId: string;
  graderId: string;
}

export interface AssignmentResponse {
  assignment: Assignment;
  submission: Submission;
}

export interface HistoryRecord {
  eventId: string;
  submissionId: string;
  type: AuditEvent['type'];
  actorId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface QueueResponse {
  items: QueueItem[];
  total: number;
  examId: string;
}

export interface GraderQueueResponse {
  graderId: string;
  items: QueueItem[];
  activeCount: number;
  graderCapacity: number;
}
