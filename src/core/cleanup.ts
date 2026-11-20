import { API_BASE } from './client';
import { FILE_ID } from './files';
import { confirmCleanup, liveUploadIds, pendingUploads, stageUpload } from './store';

export async function uploadKeyTag(key: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}

// Serialize ownership installation with the final liveness check and remote deletion.
const withUploadLock = <T>(action: () => Promise<T>) => navigator.locks.request('ds-api-upload-cleanup', action);

export function adoptUpload(sessionId: string, fileId: string, keyTag: string, adopt: () => Promise<boolean>) {
  return withUploadLock(async () => {
    await stageUpload(sessionId, fileId, keyTag);
    return adopt();
  });
}

interface Scope { sessionId: string; ids?: string[] }
/** Omit scope only for a user-initiated popup retry, including legacy uploads under the selected key. */
export async function retryCleanup(apiKey: string, scope?: Scope, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (scope?.ids?.length === 0) return 0;
  return withUploadLock(async () => {
    const ids = scope?.ids && new Set(scope.ids);
    const rows = (await pendingUploads()).filter(({ sessionId: [, session, , id] }) =>
      !scope || (scope.sessionId === session && (!ids || ids.has(id))));
    if (!apiKey || !rows.length) return rows.length;
    const keyTag = await uploadKeyTag(apiKey);
    const live = await liveUploadIds();
    const confirmed = new Set<string>();
    let remaining = rows.length;
    for (const row of rows) {
      const [, , owner, id] = row.sessionId;
      if (live.has(id) || !FILE_ID.test(id) || (owner ? owner !== keyTag : scope !== undefined)) continue;
      if (!confirmed.has(id)) {
        try {
          const res = await fetchImpl(`${API_BASE}/files/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
          });
          if (!res.ok) continue;
          const receipt = await res.json();
          // Some responses omit id. For legacy rows without a key fingerprint require a matching receipt ID.
          if (receipt?.deleted !== true || ((receipt.id !== undefined || !owner) && receipt.id !== id)) continue;
          confirmed.add(id);
        } catch {
          continue;
        }
      }
      await confirmCleanup(row);
      remaining--;
    }
    return remaining;
  });
}
