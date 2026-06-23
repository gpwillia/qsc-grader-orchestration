import { useEffect, useMemo, useState } from 'react';
import type { AuthUser, HistoryRecord, QueueItem } from '@qsc/contracts';
import './app.css';

type LoginResponse = {
  accessToken: string;
  tokenType: string;
  user: AuthUser;
};

type GradersResponse = {
  graders: AuthUser[];
  total: number;
};

type ExamQueueResponse = {
  items: QueueItem[];
  total: number;
  examId: string;
};

type GraderQueueResponse = {
  graderId: string;
  items: QueueItem[];
  activeCount: number;
  graderCapacity: number;
};

type HistoryResponse = {
  submissionId: string;
  events: HistoryRecord[];
};

type SystemHealthResponse = {
  service: string;
  ok: boolean;
  intellumApiBaseUrl: string;
  pollIntervalSeconds: number;
  dbConfigured: boolean;
  users: number;
  cachedSubmissions: number;
  assigned: number;
  inProgress: number;
  lastSyncAt: string | null;
  watermark: string;
};

type RecentGradedItem = {
  submissionId: string;
  examId: string;
  learnerId: string;
  result: 'PASS' | 'FAIL' | null;
  gradedAt: string;
};

type RecentGradedResponse = {
  graderId: string;
  items: RecentGradedItem[];
  total: number;
};

type ActiveItem = QueueItem & {
  activeState: 'ASSIGNED' | 'IN_PROGRESS';
};

const EXAMS = ['EXAM-AUDIO-101', 'EXAM-CONTROL-201', 'EXAM-DSP-301', 'EXAM-VIDEO-401'];

const STORAGE_KEYS = {
  apiBase: 'qsc.ui.apiBase',
  token: 'qsc.ui.token',
  user: 'qsc.ui.user'
};

async function parseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (${response.status})`);
  }
  return data as T;
}

function buildHeaders(token?: string): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function formatRelative(isoTimestamp?: string): string {
  if (!isoTimestamp) {
    return '-';
  }
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const deltaMinutes = Math.max(0, Math.floor((now - then) / 60000));
  if (deltaMinutes < 1) {
    return 'just now';
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function submissionAgeMinutes(item: QueueItem): number {
  const created = new Date(item.submission.createdAt).getTime();
  return Math.max(0, Math.floor((Date.now() - created) / 60000));
}

export function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(() => localStorage.getItem(STORAGE_KEYS.apiBase) ?? 'http://localhost:8789');
  const [email, setEmail] = useState('admin@qsc.demo');
  const [password, setPassword] = useState('admin');

  const [token, setToken] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.token) ?? '');
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEYS.user);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  });

  const [selectedExam, setSelectedExam] = useState(EXAMS[0]);
  const [selectedGraderFilter, setSelectedGraderFilter] = useState('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<'ALL' | 'UNASSIGNED' | 'ASSIGNED' | 'IN_PROGRESS'>('ALL');
  const [ageFilter, setAgeFilter] = useState<'ALL' | '15' | '60' | '240'>('ALL');
  const [search, setSearch] = useState('');
  const [pastDueMinutes, setPastDueMinutes] = useState(90);

  const [graders, setGraders] = useState<AuthUser[]>([]);
  const [examQueue, setExamQueue] = useState<QueueItem[]>([]);
  const [activeItems, setActiveItems] = useState<ActiveItem[]>([]);
  const [graderQueue, setGraderQueue] = useState<QueueItem[]>([]);

  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [recentGraded, setRecentGraded] = useState<RecentGradedItem[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealthResponse | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string>('');
  const [assignGraderBySubmission, setAssignGraderBySubmission] = useState<Record<string, string>>({});
  const [reassignGraderBySubmission, setReassignGraderBySubmission] = useState<Record<string, string>>({});
  const [actionPendingBySubmission, setActionPendingBySubmission] = useState<Record<string, boolean>>({});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const apiUnavailable = error.toLowerCase().includes('failed to fetch');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.apiBase, apiBaseUrl);
  }, [apiBaseUrl]);

  function setPending(submissionId: string, value: boolean) {
    setActionPendingBySubmission((prev) => ({
      ...prev,
      [submissionId]: value
    }));
  }

  async function login() {
    setError('');
    setStatus('Signing in...');
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ email, password })
      });
      const data = await parseJson<LoginResponse>(response);

      setToken(data.accessToken);
      setUser(data.user);
      localStorage.setItem(STORAGE_KEYS.token, data.accessToken);
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data.user));
      setStatus(`Signed in as ${data.user.role}. Syncing data...`);

      // Auto-sync and load data immediately after login
      if (data.user.role === 'ADMIN') {
        try {
          await fetch(`${apiBaseUrl}/api/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.accessToken}` }
          });
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      setError(String(err));
      setStatus('');
    }
  }

  function logout() {
    setToken('');
    setUser(null);
    setGraders([]);
    setExamQueue([]);
    setActiveItems([]);
    setGraderQueue([]);
    setHistory([]);
    setSelectedSubmissionId('');
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.user);
    setStatus('Signed out.');
  }

  async function manualSync() {
    if (!token || user?.role !== 'ADMIN') {
      return;
    }

    setStatus('Syncing from Intellum...');
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/sync`, {
        method: 'POST',
        headers: buildHeaders(token)
      });
      await parseJson<{ skipped: boolean }>(response);
      setStatus('Sync complete.');
      await refreshForRole();
    } catch (err) {
      setError(String(err));
      setStatus('');
    }
  }

  async function refreshAdmin(examId = selectedExam, historySubmissionId = selectedSubmissionId) {
    if (!token) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const healthResponse = await fetch(`${apiBaseUrl}/health`, {
        headers: buildHeaders(token)
      });
      const healthData = await parseJson<SystemHealthResponse>(healthResponse);
      setSystemHealth(healthData);

      const gradersResponse = await fetch(`${apiBaseUrl}/api/graders`, {
        headers: buildHeaders(token)
      });
      const gradersData = await parseJson<GradersResponse>(gradersResponse);
      setGraders(gradersData.graders);

      const examQueueResponse = await fetch(`${apiBaseUrl}/api/exams/${examId}/queue`, {
        headers: buildHeaders(token)
      });
      const examData = await parseJson<ExamQueueResponse>(examQueueResponse);
      setExamQueue(examData.items);

      const activeResponses = await Promise.all(
        gradersData.graders.map(async (grader) => {
          const response = await fetch(`${apiBaseUrl}/api/graders/${grader.id}/queue`, {
            headers: buildHeaders(token)
          });
          const data = await parseJson<GraderQueueResponse>(response);
          return data.items
            .filter((item) => item.assignment?.state === 'ASSIGNED' || item.assignment?.state === 'IN_PROGRESS')
            .map((item) => ({
              ...item,
              activeState: (item.assignment?.state ?? 'ASSIGNED') as 'ASSIGNED' | 'IN_PROGRESS'
            }));
        })
      );
      setActiveItems(activeResponses.flat());

      if (historySubmissionId) {
        const historyResponse = await fetch(`${apiBaseUrl}/api/submissions/${historySubmissionId}/history`, {
          headers: buildHeaders(token)
        });
        const historyData = await parseJson<HistoryResponse>(historyResponse);
        setHistory(historyData.events);
      }

      setStatus(`Updated ${examData.total} queue items for ${examId}.`);
    } catch (err) {
      setSystemHealth(null);
      setError(String(err));
      setStatus('');
    } finally {
      setLoading(false);
    }
  }

  async function refreshGrader(historySubmissionId = selectedSubmissionId) {
    if (!token || !user) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/graders/${user.id}/queue`, {
        headers: buildHeaders(token)
      });
      const data = await parseJson<GraderQueueResponse>(response);
      setGraderQueue(data.items);

      const recentResponse = await fetch(`${apiBaseUrl}/api/graders/${user.id}/recent-graded?limit=12`, {
        headers: buildHeaders(token)
      });
      const recentData = await parseJson<RecentGradedResponse>(recentResponse);
      setRecentGraded(recentData.items);

      if (historySubmissionId) {
        const historyResponse = await fetch(`${apiBaseUrl}/api/submissions/${historySubmissionId}/history`, {
          headers: buildHeaders(token)
        });
        const historyData = await parseJson<HistoryResponse>(historyResponse);
        setHistory(historyData.events);
      }

      setStatus(`Loaded ${data.activeCount} active items.`);
    } catch (err) {
      setRecentGraded([]);
      setError(String(err));
      setStatus('');
    } finally {
      setLoading(false);
    }
  }

  async function refreshForRole() {
    if (user?.role === 'ADMIN') {
      await refreshAdmin();
    } else {
      await refreshGrader();
    }
  }

  async function assign(submissionId: string) {
    const graderId = assignGraderBySubmission[submissionId];
    if (!graderId || !token || user?.role !== 'ADMIN') {
      return;
    }

    setPending(submissionId, true);
    setStatus(`Assigning ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/assignments`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ submissionId, graderId })
      });
      await parseJson<{ success: boolean }>(response);
      setStatus(`${submissionId} assigned to ${graderId}.`);
      await refreshAdmin();
    } catch (err) {
      setError(String(err));
      setStatus('');
    } finally {
      setPending(submissionId, false);
    }
  }

  async function reassign(submissionId: string) {
    const graderId = reassignGraderBySubmission[submissionId];
    if (!graderId || !token || user?.role !== 'ADMIN') {
      return;
    }

    setPending(submissionId, true);
    setStatus(`Reassigning ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/assignments/${submissionId}/reassign`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ graderId })
      });
      await parseJson<{ success: boolean }>(response);
      setStatus(`${submissionId} reassigned to ${graderId}.`);
      await refreshAdmin();
    } catch (err) {
      setError(String(err));
      setStatus('');
    } finally {
      setPending(submissionId, false);
    }
  }

  async function unassign(submissionId: string) {
    if (!token || user?.role !== 'ADMIN') {
      return;
    }

    if (!window.confirm(`Return ${submissionId} to unassigned queue?`)) {
      return;
    }

    setPending(submissionId, true);
    setStatus(`Unassigning ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/assignments/${submissionId}/unassign`, {
        method: 'POST',
        headers: buildHeaders(token)
      });
      await parseJson<{ success: boolean }>(response);
      setStatus(`${submissionId} returned to queue.`);
      await refreshAdmin();
    } catch (err) {
      setError(String(err));
      setStatus('');
    } finally {
      setPending(submissionId, false);
    }
  }

  async function startWork(submissionId: string, state?: string) {
    if (!token || user?.role !== 'GRADER') {
      return;
    }
    if (state !== 'ASSIGNED') {
      return;
    }

    setPending(submissionId, true);
    setStatus(`Starting ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/assignments/${submissionId}/start`, {
        method: 'POST',
        headers: buildHeaders(token)
      });
      await parseJson<{ started: boolean }>(response);
      setStatus(`${submissionId} moved to IN_PROGRESS.`);
      await refreshGrader(submissionId);
    } catch (err) {
      setError(String(err));
      setStatus('');
    } finally {
      setPending(submissionId, false);
    }
  }

  async function gradeWork(submissionId: string, state: string | undefined, result: 'PASS' | 'FAIL') {
    if (!token || user?.role !== 'GRADER') {
      return;
    }
    if (state !== 'IN_PROGRESS') {
      return;
    }
    if (!window.confirm(`Submit ${result} for ${submissionId}?`)) {
      return;
    }

    setPending(submissionId, true);
    setStatus(`Submitting ${result} for ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/assignments/${submissionId}/grade`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ result })
      });
      await parseJson<{ success: boolean; isIdempotent: boolean }>(response);
      setStatus(`${submissionId} graded ${result}. Queue refreshed.`);
      await refreshGrader(submissionId);
    } catch (err) {
      setError(String(err));
      setStatus('');
    } finally {
      setPending(submissionId, false);
    }
  }

  async function viewHistory(submissionId: string) {
    if (!token) {
      return;
    }

    setSelectedSubmissionId(submissionId);
    setStatus(`Loading history for ${submissionId}...`);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/submissions/${submissionId}/history`, {
        headers: buildHeaders(token)
      });
      const data = await parseJson<HistoryResponse>(response);
      setHistory(data.events);
      setStatus(`Loaded ${data.events.length} events for ${submissionId}.`);
    } catch (err) {
      setError(String(err));
      setStatus('');
    }
  }

  useEffect(() => {
    if (token && user) {
      void refreshForRole();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id, user?.role]);

  const filteredExamQueue = useMemo(() => {
    return examQueue
      .filter((item) => {
        if (selectedStatusFilter === 'ALL') {
          return true;
        }
        if (selectedStatusFilter === 'UNASSIGNED') {
          return !item.assignment;
        }
        return item.assignment?.state === selectedStatusFilter;
      })
      .filter((item) => (selectedGraderFilter === 'ALL' ? true : (item.assignment?.graderId ?? 'UNASSIGNED') === selectedGraderFilter))
      .filter((item) => {
        if (ageFilter === 'ALL') {
          return true;
        }
        return submissionAgeMinutes(item) >= Number(ageFilter);
      })
      .filter((item) => {
        const term = search.trim().toLowerCase();
        if (!term) {
          return true;
        }
        return (
          item.submission.id.toLowerCase().includes(term) ||
          item.submission.learnerId.toLowerCase().includes(term) ||
          item.submission.attemptId.toLowerCase().includes(term)
        );
      });
  }, [examQueue, selectedStatusFilter, selectedGraderFilter, ageFilter, search]);

  const filteredActive = useMemo(() => {
    return activeItems
      .filter((item) => {
        if (selectedStatusFilter === 'ALL') {
          return true;
        }
        if (selectedStatusFilter === 'UNASSIGNED') {
          return false;
        }
        return item.activeState === selectedStatusFilter;
      })
      .filter((item) => (selectedGraderFilter === 'ALL' ? true : item.assignment?.graderId === selectedGraderFilter))
      .filter((item) => {
        if (ageFilter === 'ALL') {
          return true;
        }
        return submissionAgeMinutes(item) >= Number(ageFilter);
      })
      .filter((item) => {
        const term = search.trim().toLowerCase();
        if (!term) {
          return true;
        }
        return (
          item.submission.id.toLowerCase().includes(term) ||
          item.submission.learnerId.toLowerCase().includes(term) ||
          item.submission.attemptId.toLowerCase().includes(term)
        );
      });
  }, [activeItems, selectedStatusFilter, selectedGraderFilter, ageFilter, search]);

  const graderAssigned = useMemo(
    () => graderQueue.filter((item) => item.assignment?.state === 'ASSIGNED'),
    [graderQueue]
  );
  const graderInProgress = useMemo(
    () => graderQueue.filter((item) => item.assignment?.state === 'IN_PROGRESS'),
    [graderQueue]
  );

  function adminQueueEmptyMessage(): string {
    if (apiUnavailable) {
      return 'API is unreachable. Verify API Base URL and orchestration service is running.';
    }
    if (examQueue.length === 0) {
      return `No unassigned items found for ${selectedExam}. Click Manual Sync or choose another exam.`;
    }
    return 'No matching unassigned items for current filters. Adjust filters or search.';
  }

  function graderQueueEmptyMessage(): string {
    if (apiUnavailable) {
      return 'API is unreachable. Verify API Base URL and orchestration service is running.';
    }
    return 'No active submissions in your queue. Ask an admin to assign work, then click Refresh Queue.';
  }

  if (!token || !user) {
    return (
      <div className="app-wrapper">
        <main className="shell">
          <section className="login-panel card">
            <h1>QSC Orchestration</h1>
          <p>Sign in as admin or grader to continue.</p>
          <label>
            API Base URL
            <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="http://localhost:8789" />
          </label>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@qsc.demo" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="admin" />
          </label>
          <button type="button" onClick={() => void login()}>Sign In</button>
          <div className="hint">Admin: admin@qsc.demo/admin • Grader: grader1@qsc.demo/grader</div>
            {error ? <div className="error">{error}</div> : null}
          {status ? <div className="status">{status}</div> : null}
          </section>
        </main>
      </div>
    );
  }

  if (user.role === 'ADMIN') {
    return (
      <div className="app-wrapper">
        <main className="shell">
          <header className="topbar card">
            <div>
              <h1>QSC Grader Orchestration</h1>
              <p>
                Admin mode: {user.email}
              </p>
            </div>
          <div className="topbar-actions">
            <button type="button" onClick={() => void manualSync()}>Manual Sync</button>
            <button type="button" onClick={() => void refreshAdmin()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
            <button type="button" className="ghost" onClick={logout}>Sign Out</button>
          </div>
        </header>

        <section className="filters card">
          <label>
            Exam
            <select
              value={selectedExam}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedExam(next);
                void refreshAdmin(next, selectedSubmissionId);
              }}
            >
              {EXAMS.map((exam) => (
                <option key={exam} value={exam}>{exam}</option>
              ))}
            </select>
          </label>

          <label>
            Grader Filter
            <select value={selectedGraderFilter} onChange={(e) => setSelectedGraderFilter(e.target.value)}>
              <option value="ALL">All graders</option>
              {graders.map((grader) => (
                <option key={grader.id} value={grader.id}>{grader.email}</option>
              ))}
            </select>
          </label>

          <label>
            Status Filter
            <select
              value={selectedStatusFilter}
              onChange={(e) =>
                setSelectedStatusFilter(e.target.value as 'ALL' | 'UNASSIGNED' | 'ASSIGNED' | 'IN_PROGRESS')
              }
            >
              <option value="ALL">All statuses</option>
              <option value="UNASSIGNED">Unassigned</option>
              <option value="ASSIGNED">Assigned</option>
              <option value="IN_PROGRESS">In Progress</option>
            </select>
          </label>

          <label>
            Age Filter
            <select value={ageFilter} onChange={(e) => setAgeFilter(e.target.value as 'ALL' | '15' | '60' | '240')}>
              <option value="ALL">Any age</option>
              <option value="15">15m+</option>
              <option value="60">1h+</option>
              <option value="240">4h+</option>
            </select>
          </label>

          <label>
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="submission, learner, attempt" />
          </label>

          <label>
            Past-Due Threshold (min)
            <input
              type="number"
              min={1}
              value={pastDueMinutes}
              onChange={(e) => setPastDueMinutes(Math.max(1, Number(e.target.value) || 90))}
            />
          </label>
        </section>

        {error ? <section className="error card">{error}</section> : null}
        {status ? <section className="status card">{status}</section> : null}

        <section className="card system-grid">
          <div>
            <strong>API</strong>
            <div className="subline">{systemHealth?.ok ? 'Reachable' : 'Unavailable'}</div>
          </div>
          <div>
            <strong>Cached Submissions</strong>
            <div className="subline">{systemHealth?.cachedSubmissions ?? 0}</div>
          </div>
          <div>
            <strong>Last Sync</strong>
            <div className="subline">{systemHealth?.lastSyncAt ? new Date(systemHealth.lastSyncAt).toLocaleString() : 'Not synced yet'}</div>
          </div>
          <div>
            <strong>DB</strong>
            <div className="subline">{systemHealth?.dbConfigured ? 'Configured' : 'Not configured'}</div>
          </div>
        </section>

        <section className="dashboard-grid">
          <article className="card queue-panel">
            <h2>Unassigned Queue: {selectedExam}</h2>
            <p className="muted">FIFO order by submission created time. Assign items to graders below.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Submission</th>
                    <th>Learner</th>
                    <th>Age</th>
                    <th>Past Due</th>
                    <th>Assign</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExamQueue.length === 0 ? (
                    <tr>
                      <td colSpan={6}>{adminQueueEmptyMessage()}</td>
                    </tr>
                  ) : (
                    filteredExamQueue.map((item) => {
                      const minutes = submissionAgeMinutes(item);
                      const pastDue = minutes >= pastDueMinutes;
                      return (
                        <tr key={item.submission.id}>
                          <td>
                            <strong>{item.submission.id}</strong>
                            <span className="subline">{item.submission.attemptId}</span>
                          </td>
                          <td>{item.submission.learnerId}</td>
                          <td>{formatRelative(item.submission.createdAt)}</td>
                          <td>
                            <span className={pastDue ? 'badge badge-danger' : 'badge'}>{pastDue ? 'Past Due' : 'On Track'}</span>
                          </td>
                          <td>
                            <select
                              value={assignGraderBySubmission[item.submission.id] ?? ''}
                              onChange={(e) =>
                                setAssignGraderBySubmission((prev) => ({
                                  ...prev,
                                  [item.submission.id]: e.target.value
                                }))
                              }
                            >
                              <option value="">Choose grader...</option>
                              {graders.map((grader) => (
                                <option key={grader.id} value={grader.id}>{grader.email}</option>
                              ))}
                            </select>
                          </td>
                          <td className="actions-cell">
                            <button
                              type="button"
                              onClick={() => void assign(item.submission.id)}
                              disabled={!assignGraderBySubmission[item.submission.id] || actionPendingBySubmission[item.submission.id]}
                            >
                              Assign
                            </button>
                            <button type="button" className="ghost" onClick={() => void viewHistory(item.submission.id)}>History</button>
                            <a
                              href={`http://localhost:8788/admin/submissions/${item.submission.id}?role=ADMIN`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Intellum
                            </a>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="card queue-panel">
            <h2>Active Assignments</h2>
            <p className="muted">Assigned and in-progress work across all graders.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Submission</th>
                    <th>Exam</th>
                    <th>Grader</th>
                    <th>State</th>
                    <th>Reassign</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActive.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No active items for current filters.</td>
                    </tr>
                  ) : (
                    filteredActive.map((item) => (
                      <tr key={item.submission.id}>
                        <td>
                          <strong>{item.submission.id}</strong>
                          <span className="subline">{item.submission.learnerId}</span>
                        </td>
                        <td>{item.examId}</td>
                        <td>{item.assignment?.graderId ?? '-'}</td>
                        <td>
                          <span className={item.activeState === 'IN_PROGRESS' ? 'badge badge-warn' : 'badge'}>
                            {item.activeState}
                          </span>
                        </td>
                        <td>
                          <select
                            value={reassignGraderBySubmission[item.submission.id] ?? ''}
                            onChange={(e) =>
                              setReassignGraderBySubmission((prev) => ({
                                ...prev,
                                [item.submission.id]: e.target.value
                              }))
                            }
                          >
                            <option value="">Choose grader...</option>
                            {graders.map((grader) => (
                              <option key={grader.id} value={grader.id}>{grader.email}</option>
                            ))}
                          </select>
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void reassign(item.submission.id)}
                            disabled={!reassignGraderBySubmission[item.submission.id] || actionPendingBySubmission[item.submission.id]}
                          >
                            Reassign
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void unassign(item.submission.id)}
                            disabled={actionPendingBySubmission[item.submission.id]}
                          >
                            Unassign
                          </button>
                          <button type="button" className="ghost" onClick={() => void viewHistory(item.submission.id)}>History</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="card history-panel">
            <h2>Submission History</h2>
            <p className="muted">{selectedSubmissionId ? `Timeline for ${selectedSubmissionId}` : 'Select History on a submission to inspect events.'}</p>
            <ol>
              {history.length === 0 ? (
                <li>No events loaded.</li>
              ) : (
                history.map((event) => (
                  <li key={event.eventId}>
                    <div>
                      <strong>{event.type}</strong> by {event.actorId}
                    </div>
                    <div className="subline">{new Date(event.timestamp).toLocaleString()}</div>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </li>
                ))
              )}
            </ol>
          </article>
        </section>
      </main>
    </div>
  );
  }

  return (
    <div className="app-wrapper">
      <main className="shell">
        <header className="topbar card">
          <div>
            <h1>QSC Grader Console</h1>
            <p>
              Grader mode: {user.email}
            </p>
          </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => void refreshGrader()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh Queue'}</button>
          <button type="button" className="ghost" onClick={logout}>Sign Out</button>
        </div>
      </header>

      {error ? <section className="error card">{error}</section> : null}
      {status ? <section className="status card">{status}</section> : null}

      <section className="filters card grader-summary">
        <div>
          <strong>Assigned</strong>
          <div className="subline">{graderAssigned.length}</div>
        </div>
        <div>
          <strong>In Progress</strong>
          <div className="subline">{graderInProgress.length}</div>
        </div>
        <div>
          <strong>Total Active</strong>
          <div className="subline">{graderQueue.length}</div>
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="card queue-panel">
          <h2>My Queue</h2>
          <p className="muted">Only your assigned items are shown. Start before grading.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Submission</th>
                  <th>Exam</th>
                  <th>State</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {graderQueue.length === 0 ? (
                  <tr>
                    <td colSpan={5}>{graderQueueEmptyMessage()}</td>
                  </tr>
                ) : (
                  graderQueue.map((item) => {
                    const state = item.assignment?.state;
                    const isAssigned = state === 'ASSIGNED';
                    const isInProgress = state === 'IN_PROGRESS';
                    const isPending = actionPendingBySubmission[item.submission.id] ?? false;

                    return (
                      <tr key={item.submission.id}>
                        <td>
                          <strong>{item.submission.id}</strong>
                          <span className="subline">{item.submission.learnerId}</span>
                        </td>
                        <td>{item.examId}</td>
                        <td>
                          <span className={isInProgress ? 'badge badge-warn' : 'badge'}>{state ?? 'UNKNOWN'}</span>
                        </td>
                        <td>{formatRelative(item.submission.createdAt)}</td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="ghost"
                            disabled={!isAssigned || isPending}
                            onClick={() => void startWork(item.submission.id, state)}
                          >
                            Start Work
                          </button>
                          <button
                            type="button"
                            disabled={!isInProgress || isPending}
                            onClick={() => void gradeWork(item.submission.id, state, 'PASS')}
                          >
                            PASS
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={!isInProgress || isPending}
                            onClick={() => void gradeWork(item.submission.id, state, 'FAIL')}
                          >
                            FAIL
                          </button>
                          <button type="button" className="ghost" onClick={() => void viewHistory(item.submission.id)}>History</button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="card history-panel">
          <h2>Submission History</h2>
          <p className="muted">{selectedSubmissionId ? `Timeline for ${selectedSubmissionId}` : 'Select History on a submission to inspect events.'}</p>
          <ol>
            {history.length === 0 ? (
              <li>No events loaded.</li>
            ) : (
              history.map((event) => (
                <li key={event.eventId}>
                  <div>
                    <strong>{event.type}</strong> by {event.actorId}
                  </div>
                  <div className="subline">{new Date(event.timestamp).toLocaleString()}</div>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </li>
              ))
            )}
          </ol>
        </article>

        <article className="card history-panel">
          <h2>Recently Graded By You</h2>
          <p className="muted">Latest completed submissions from your account.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Submission</th>
                  <th>Exam</th>
                  <th>Learner</th>
                  <th>Result</th>
                  <th>Graded At</th>
                </tr>
              </thead>
              <tbody>
                {recentGraded.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No completed submissions yet.</td>
                  </tr>
                ) : (
                  recentGraded.map((item) => (
                    <tr key={item.submissionId + item.gradedAt}>
                      <td>{item.submissionId}</td>
                      <td>{item.examId}</td>
                      <td>{item.learnerId}</td>
                      <td>{item.result ?? '-'}</td>
                      <td>{new Date(item.gradedAt).toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  </div>
);
}
