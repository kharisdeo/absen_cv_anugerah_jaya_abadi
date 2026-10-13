// @vitest-environment happy-dom

import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from '../src/auth/session.js';
import { EmployeeOfflineAttendanceQueue } from '../src/components/attendance/EmployeeOfflineAttendanceQueue.js';
import {
  IndexedDbQueueStorage,
  OFFLINE_QUEUE_DATABASE,
  OfflineAttendanceQueue,
} from '../src/components/attendance/offline-attendance-queue.js';

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000051';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000052';
const EMPLOYEE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000053';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000054';
const UPLOAD_REFERENCE = '00000000-0000-4000-8000-000000000055';
const PHOTO_TEXT = 'private-camera-capture-fe-009c';
const UPLOAD_URL = 'https://storage.example.test/signed-upload';

type MountedQueue = Readonly<{
  root: Root;
  container: HTMLDivElement;
  queue: OfflineAttendanceQueue;
}>;
type ListReadTracker = Readonly<{ waitForResolved: (count: number) => Promise<void> }>;

const mountedQueues: MountedQueue[] = [];
const storages: IndexedDbQueueStorage[] = [];
const queues: OfflineAttendanceQueue[] = [];
let factory: IDBFactory;
let originalActEnvironment: PropertyDescriptor | undefined;
let originalOnline: PropertyDescriptor | undefined;

beforeAll(() => {
  originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterAll(() => {
  if (originalActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

beforeEach(() => {
  factory = new IDBFactory();
  originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(async () => {
  for (const mounted of mountedQueues.splice(0)) {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  }
  queues.splice(0);
  for (const storage of storages.splice(0)) storage.close();
  await Promise.resolve();

  const deletion = factory.deleteDatabase(OFFLINE_QUEUE_DATABASE);
  await new Promise<void>((resolve, reject) => {
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error('IndexedDB cleanup failed'));
    deletion.onblocked = () => reject(new Error('IndexedDB cleanup was blocked'));
  });

  vi.unstubAllGlobals();
  if (originalOnline) {
    Object.defineProperty(navigator, 'onLine', originalOnline);
  } else {
    Reflect.deleteProperty(navigator, 'onLine');
  }
});

function createQueue(): OfflineAttendanceQueue {
  const storage = new IndexedDbQueueStorage(factory);
  storages.push(storage);
  const queue = new OfflineAttendanceQueue(storage);
  queues.push(queue);
  return queue;
}

function sessionFor(employeeId: string, accountId: string): SessionState {
  return {
    status: 'authenticated',
    user: {
      id: accountId,
      username: 'karyawan-contoh',
      role: 'EMPLOYEE',
      employeeId,
      deviceBindingStatus: 'APPROVED',
      mustChangePassword: false,
      consentRequired: false,
    },
  };
}

function response(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function blockingUploadFetcher() {
  const uploadStarted = deferred<void>();
  const uploadAborted = deferred<void>();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let uploadSignal: AbortSignal | null = null;

  const fetcher: typeof fetch = vi.fn((input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.endsWith('/attendance/selfie-upload-intents')) {
      return Promise.resolve(
        response(201, {
          referenceId: UPLOAD_REFERENCE,
          uploadUrl: UPLOAD_URL,
          requiredHeaders: {
            'Content-Type': 'image/jpeg',
            'x-amz-meta-referencehash': 'synthetic-reference-hash',
          },
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
      );
    }

    if (url === UPLOAD_URL) {
      uploadSignal = init.signal as AbortSignal | null;
      uploadStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const rejectForAbort = () => {
          uploadAborted.resolve();
          reject(new DOMException('Upload aborted after logout', 'AbortError'));
        };
        if (!uploadSignal) {
          reject(new Error('Expected an AbortSignal for the signed upload'));
          return;
        }
        if (uploadSignal.aborted) {
          rejectForAbort();
          return;
        }
        uploadSignal.addEventListener('abort', rejectForAbort, { once: true });
      });
    }

    return Promise.reject(new Error(`Unexpected attendance request: ${url}`));
  });

  return {
    fetcher,
    requests,
    uploadAborted: uploadAborted.promise,
    uploadStarted: uploadStarted.promise,
    getUploadSignal: () => uploadSignal,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

function trackResolvedListReads(queue: OfflineAttendanceQueue): ListReadTracker {
  const originalList = queue.list.bind(queue);
  let resolvedCount = 0;
  const waiters = new Map<number, Array<() => void>>();

  const waitForResolved = (count: number): Promise<void> => {
    if (resolvedCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const pending = waiters.get(count) ?? [];
      pending.push(resolve);
      waiters.set(count, pending);
    });
  };

  vi.spyOn(queue, 'list').mockImplementation(async (employeeId, includePhotos) => {
    const entries = await originalList(employeeId, includePhotos);
    resolvedCount += 1;
    for (const [target, listeners] of waiters) {
      if (target <= resolvedCount) {
        waiters.delete(target);
        for (const resolve of listeners) resolve();
      }
    }
    return entries;
  });

  return { waitForResolved };
}

async function mountQueue(
  queue: OfflineAttendanceQueue,
  employeeId: string,
  refreshSession: () => Promise<SessionState>,
  onReceipt = vi.fn(),
): Promise<MountedQueue> {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = { root: createRoot(container), container, queue };
  mountedQueues.push(mounted);
  await act(async () => {
    mounted.root.render(
      <EmployeeOfflineAttendanceQueue
        employeeId={employeeId}
        onReceipt={onReceipt}
        queue={queue}
        refreshKey={0}
        refreshSession={refreshSession}
      />,
    );
  });
  return mounted;
}

describe('mounted employee offline queue logout behavior', () => {
  it('aborts an in-flight upload on unmount and retains only the encrypted pending capture', async () => {
    const queue = createQueue();
    const entryId = await queue.enqueue(EMPLOYEE_ID, {
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
      photo: new Blob([PHOTO_TEXT], { type: 'image/jpeg' }),
      location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    });
    const blocking = blockingUploadFetcher();
    const onReceipt = vi.fn();
    const refreshSession = vi.fn(async () => sessionFor(EMPLOYEE_ID, EMPLOYEE_ACCOUNT_ID));
    vi.stubGlobal('fetch', blocking.fetcher);

    const mounted = await mountQueue(queue, EMPLOYEE_ID, refreshSession, onReceipt);
    await act(async () => {
      await blocking.uploadStarted;
    });

    expect(mounted.container.textContent).toContain('Belum tersinkron');
    expect(mounted.container.textContent).toContain(
      `ID antrean lokal (bukan kode bukti server): ${entryId}`,
    );
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(blocking.requests.map(({ init }) => init.method)).toEqual(['POST', 'PUT']);
    expect(blocking.requests[1]?.init.credentials).toBe('omit');

    await act(async () => {
      mounted.root.unmount();
      await blocking.uploadAborted;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    mounted.container.remove();
    mountedQueues.splice(mountedQueues.indexOf(mounted), 1);

    expect(blocking.getUploadSignal()?.aborted).toBe(true);
    expect(blocking.requests.map(({ url }) => url)).toEqual([
      expect.stringContaining('/attendance/selfie-upload-intents'),
      UPLOAD_URL,
    ]);
    expect(blocking.requests.some(({ url }) => url.includes('/attendance/attempts'))).toBe(false);
    expect(onReceipt).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toBe('');

    queue.close();
    await Promise.resolve();
    const reopenedQueue = createQueue();
    const retained = await reopenedQueue.get(EMPLOYEE_ID, entryId);
    expect(retained?.payload.kind).toBe('pending');
    expect(retained?.photo).toBeInstanceOf(Blob);

    const inspector = new IndexedDbQueueStorage(factory);
    storages.push(inspector);
    const rawEntries = await inspector.readEntries();
    const serialized = JSON.stringify(rawEntries);
    for (const plaintext of [
      EMPLOYEE_ID,
      '2026-10-11T10:00:00+07:00',
      '-6.200124',
      '106.800988',
      PHOTO_TEXT,
    ]) {
      expect(serialized).not.toContain(plaintext);
    }
  });

  it('does not show another employee the pending row after the first owner unmounts', async () => {
    const queue = createQueue();
    const entryId = await queue.enqueue(EMPLOYEE_ID, {
      type: 'CHECK_OUT',
      clientRecordedAt: '2026-10-11T18:00:00+07:00',
      photo: new Blob([PHOTO_TEXT], { type: 'image/jpeg' }),
      location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
    });
    const inspector = new IndexedDbQueueStorage(factory);
    storages.push(inspector);
    const originalEntry = (await inspector.readEntries()).find((entry) => entry.id === entryId);
    if (!originalEntry) throw new Error('Expected the queued ciphertext to be stored');
    const originalCiphertext = Array.from(new Uint8Array(originalEntry.ciphertext));

    const fetcher: typeof fetch = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    setOnline(false);

    const firstOwnerListReads = trackResolvedListReads(queue);
    const firstOwner = await mountQueue(queue, EMPLOYEE_ID, async () =>
      sessionFor(EMPLOYEE_ID, EMPLOYEE_ACCOUNT_ID),
    );
    await act(async () => {
      await firstOwnerListReads.waitForResolved(1);
    });
    expect(firstOwner.container.textContent).toContain(entryId);
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      firstOwner.root.unmount();
    });
    firstOwner.container.remove();
    mountedQueues.splice(mountedQueues.indexOf(firstOwner), 1);

    queue.close();
    await Promise.resolve();
    const reopenedQueue = createQueue();

    const secondOwnerListReads = trackResolvedListReads(reopenedQueue);
    const secondOwner = await mountQueue(reopenedQueue, OTHER_EMPLOYEE_ID, async () =>
      sessionFor(OTHER_EMPLOYEE_ID, OTHER_ACCOUNT_ID),
    );
    await act(async () => {
      await secondOwnerListReads.waitForResolved(1);
    });

    expect(secondOwner.container.textContent).toContain(
      'Tidak ada item antrean lokal yang menunggu atau receipt lokal yang tersimpan.',
    );
    expect(secondOwner.container.textContent).not.toContain(entryId);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await reopenedQueue.get(EMPLOYEE_ID, entryId))?.payload.kind).toBe('pending');

    const retainedEntry = (await inspector.readEntries()).find((entry) => entry.id === entryId);
    if (!retainedEntry) throw new Error('Expected the original queued ciphertext to be retained');
    expect(Array.from(new Uint8Array(retainedEntry.ciphertext))).toEqual(originalCiphertext);
  });
});
