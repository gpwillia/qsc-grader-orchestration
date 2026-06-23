import type { Submission } from '@qsc/contracts';
import type { OrchestrationStore, SyncStats } from './db.js';

interface IntellumListResponse {
  submissions: Submission[];
  total: number;
}

export async function runNeedsGradingSync(
  store: OrchestrationStore,
  intellumApiBaseUrl: string
): Promise<SyncStats> {
  const watermark = await store.getSyncWatermark();
  const url = new URL('/api/submissions', intellumApiBaseUrl);
  url.searchParams.set('status', 'NEEDS_GRADING');
  url.searchParams.set('since', watermark);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Intellum sync request failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as IntellumListResponse;
  const submissions = Array.isArray(payload.submissions) ? payload.submissions : [];

  return store.syncNeedsGradingSubmissions(submissions);
}
