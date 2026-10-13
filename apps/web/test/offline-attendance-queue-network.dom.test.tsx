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

const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000061';
const EMPLOYEE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000062';

type MountedQueue = Readonly<{ root: Root; container: HTMLDivElement }>;
type ListReadTracker = Readonly<{ waitForResolved: (count: number) => Promise<void> }>;

const mountedQueues: MountedQueue[] = [];
const storages: IndexedDbQueueStorage[] = [];
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
  setOnline(true);
});

afterEach(async () => {
  for (const mounted of mountedQueues.splice(0)) {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  }
  for (const storage of storages.splice(0)) storage.close();
  await Promise.resolve();
  await Promise.resolve();

  const deletion = factory.deleteDatabase(OFFLINE_QUEUE_DATABASE);
  await new Promise<void>((resolve, reject) => {
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error('IndexedDB cleanup failed'));
    deletion.onblocked = () => reject(new Error('IndexedDB cleanup was blocked'));
  });

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalOnline) {
    Object.defineProperty(navigator, 'onLine', originalOnline);
  } else {
    Reflect.deleteProperty(navigator, 'onLine');
  }
});

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

function createQueue(): OfflineAttendanceQueue {
  const storage = new IndexedDbQueueStorage(factory);
  storages.push(storage);
  return new OfflineAttendanceQueue(storage);
}

async function enqueuePendingCapture(queue: OfflineAttendanceQueue): Promise<string> {
  return queue.enqueue(EMPLOYEE_ID, {
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    photo: new Blob(['synthetic-offline-attendance-photo'], { type: 'image/jpeg' }),
    location: { latitude: -6.2001239, longitude: 106.8009876, accuracyMeters: 12.347 },
  });
}

function pendingBindingSession(): SessionState {
  return {
    status: 'authenticated',
    user: {
      id: EMPLOYEE_ACCOUNT_ID,
      username: 'karyawan-fixture',
      role: 'EMPLOYEE',
      employeeId: EMPLOYEE_ID,
      deviceBindingStatus: 'PENDING',
      mustChangePassword: false,
      consentRequired: false,
    },
  };
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
  refreshSession: () => Promise<SessionState>,
): Promise<MountedQueue> {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = { root: createRoot(container), container };
  mountedQueues.push(mounted);
  await act(async () => {
    mounted.root.render(
      <EmployeeOfflineAttendanceQueue
        employeeId={EMPLOYEE_ID}
        onReceipt={vi.fn()}
        queue={queue}
        refreshKey={0}
        refreshSession={refreshSession}
      />,
    );
  });
  return mounted;
}

function syncButton(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('Expected the manual queue sync button to be mounted');
  return button;
}

describe('mounted employee offline queue network states', () => {
  it('keeps a pending capture waiting while offline without checking a session or fetching', async () => {
    setOnline(false);
    const queue = createQueue();
    const entryId = await enqueuePendingCapture(queue);
    const listReads = trackResolvedListReads(queue);
    const fetcher: typeof fetch = vi.fn(() =>
      Promise.reject(new Error('Unexpected network request in offline regression test')),
    );
    const refreshSession = vi.fn(async () => pendingBindingSession());
    vi.stubGlobal('fetch', fetcher);

    const mounted = await mountQueue(queue, refreshSession);
    await act(async () => {
      await listReads.waitForResolved(1);
    });

    expect(mounted.container.querySelector('.offline-queue__connection')?.textContent).toBe(
      'Menunggu jaringan',
    );
    expect(mounted.container.textContent).toContain(entryId);
    expect(mounted.container.textContent).toContain('Belum tersinkron');
    expect(syncButton(mounted.container).disabled).toBe(true);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await queue.get(EMPLOYEE_ID, entryId))?.payload.kind).toBe('pending');
  });

  it('rechecks a pending owner on manual sync after foreground verification fails', async () => {
    const queue = createQueue();
    const entryId = await enqueuePendingCapture(queue);
    const listReads = trackResolvedListReads(queue);
    const fetcher: typeof fetch = vi.fn(() =>
      Promise.reject(new Error('Unexpected network request for an unverified owner')),
    );
    const refreshSession = vi.fn(async () => pendingBindingSession());
    vi.stubGlobal('fetch', fetcher);

    const mounted = await mountQueue(queue, refreshSession);
    await act(async () => {
      await listReads.waitForResolved(3);
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('.offline-queue__connection')?.textContent).toBe(
      'Jaringan terhubung',
    );
    expect(syncButton(mounted.container).textContent).toBe('Sinkronkan antrean');
    expect(syncButton(mounted.container).disabled).toBe(false);
    expect(mounted.container.textContent).toContain('Sesi belum dapat diverifikasi.');
    expect(mounted.container.textContent).toContain(entryId);
    expect(mounted.container.textContent).toContain('Belum tersinkron');
    expect(mounted.container.textContent).not.toContain('Diterima server');
    expect(mounted.container.textContent).not.toContain('Receipt server');
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      syncButton(mounted.container).click();
      await listReads.waitForResolved(5);
    });

    expect(refreshSession).toHaveBeenCalledTimes(2);
    expect(syncButton(mounted.container).textContent).toBe('Sinkronkan antrean');
    expect(syncButton(mounted.container).disabled).toBe(false);
    expect(mounted.container.textContent).toContain('Sesi belum dapat diverifikasi.');
    expect(mounted.container.textContent).toContain('Belum tersinkron');
    expect(mounted.container.textContent).not.toContain('Diterima server');
    expect(mounted.container.textContent).not.toContain('Receipt server');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await queue.get(EMPLOYEE_ID, entryId))?.payload.kind).toBe('pending');
  });
});
