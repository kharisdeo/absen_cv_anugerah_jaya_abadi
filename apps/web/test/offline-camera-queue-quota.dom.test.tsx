// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EmployeeDto } from '../src/api/admin-employees-api.js';
import type { AttendanceReceipt } from '../src/api/attendance-api.js';
import { CameraCaptureDialog } from '../src/components/attendance/CameraCaptureDialog.js';
import { MAX_CAPTURE_BYTES } from '../src/components/attendance/camera-capture.js';
import {
  OfflineAttendanceQueue,
  OfflineQueueError,
  type OfflineQueueStorage,
} from '../src/components/attendance/offline-attendance-queue.js';

const EMPLOYEE_FIXTURE = {
  id: '00000000-0000-4000-8000-000000000061',
  nik: '1000000001',
  fullName: 'Karyawan Uji Offline',
  position: 'Staf Operasional',
  status: 'ACTIVE',
  employmentDate: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
} satisfies EmployeeDto;

const LOCAL_QUEUE_ID = '00000000-0000-4000-8000-000000000062';
const CLIENT_RECORDED_AT = '2026-10-11T03:00:00.000Z';

type EnqueueCapture = Parameters<OfflineAttendanceQueue['enqueue']>[1];
type EnqueueCall = Readonly<{ employeeId: string; capture: EnqueueCapture }>;
type MountedDialog = Readonly<{ root: Root; container: HTMLDivElement }>;
type SavedDescriptor = Readonly<{
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}>;

const unusedStorage: OfflineQueueStorage = {
  async readKeys() {
    return [];
  },
  async writeKey() {
    throw new Error('The quota test double must not write a key.');
  },
  async readEntries() {
    return [];
  },
  async writeEntry() {
    throw new Error('The quota test double must not write an entry.');
  },
  async acquireLease() {
    return false;
  },
  async releaseLease() {},
};

class QuotaThenAvailableQueue extends OfflineAttendanceQueue {
  readonly calls: EnqueueCall[] = [];

  private availableResult: Promise<string> | null = null;

  constructor() {
    super(unusedStorage);
  }

  override enqueue(employeeId: string, capture: EnqueueCapture): Promise<string> {
    this.calls.push({ employeeId, capture });
    if (!this.availableResult) return Promise.reject(new OfflineQueueError('QUOTA'));
    return this.availableResult;
  }

  makeAvailable(result: Promise<string>) {
    this.availableResult = result;
  }
}

const mountedDialogs: MountedDialog[] = [];
const queues: QuotaThenAvailableQueue[] = [];
const savedDescriptors: SavedDescriptor[] = [];
let originalActEnvironment: PropertyDescriptor | undefined;
let resolvePendingEnqueue: ((queueId: string) => void) | null = null;

function replaceProperty(target: object, key: PropertyKey, value: unknown) {
  savedDescriptors.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

function restoreProperties() {
  for (const saved of savedDescriptors.splice(0).reverse()) {
    if (saved.descriptor) Object.defineProperty(saved.target, saved.key, saved.descriptor);
    else Reflect.deleteProperty(saved.target, saved.key);
  }
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Expected button: ${label}`);
  return button;
}

async function clickAndFlush(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await flushMicrotasks();
  });
}

function installDeviceAndMediaMocks() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
  getUserMedia.mockResolvedValue(stream);

  const getCurrentPosition = vi.fn(
    (
      success: PositionCallback,
      failure?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) => {
      void failure;
      void options;
      success({
        coords: {
          latitude: -6.2,
          longitude: 106.8,
          accuracy: 12,
        } as GeolocationCoordinates,
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
  );
  const watchPosition = vi.fn();

  replaceProperty(navigator, 'mediaDevices', { getUserMedia });
  replaceProperty(navigator, 'geolocation', { getCurrentPosition, watchPosition });
  replaceProperty(navigator, 'onLine', false);
  replaceProperty(HTMLDialogElement.prototype, 'showModal', function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  replaceProperty(HTMLDialogElement.prototype, 'close', function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  replaceProperty(HTMLVideoElement.prototype, 'srcObject', null);
  replaceProperty(HTMLVideoElement.prototype, 'videoWidth', 640);
  replaceProperty(HTMLVideoElement.prototype, 'videoHeight', 480);
  replaceProperty(
    HTMLMediaElement.prototype,
    'play',
    vi.fn(() => Promise.resolve()),
  );

  const drawImage = vi.fn();
  replaceProperty(
    HTMLCanvasElement.prototype,
    'getContext',
    vi.fn((contextId: string) =>
      contextId === '2d' ? ({ drawImage } as unknown as CanvasRenderingContext2D) : null,
    ),
  );
  const encodedBlob = new Blob([new Uint8Array(32 * 1024)], { type: 'image/jpeg' });
  const toBlob = vi.fn((callback: BlobCallback, type = 'image/jpeg', quality?: number) => {
    void quality;
    callback(type === 'image/jpeg' ? encodedBlob : new Blob([encodedBlob], { type }));
  });
  replaceProperty(HTMLCanvasElement.prototype, 'toBlob', toBlob);
  replaceProperty(
    URL,
    'createObjectURL',
    vi.fn(() => 'blob:offline-camera-quota-test'),
  );
  replaceProperty(URL, 'revokeObjectURL', vi.fn());

  return { getUserMedia, getCurrentPosition, watchPosition, tracks, toBlob, drawImage };
}

async function mountDialog(
  queue: QuotaThenAvailableQueue,
  onQueued: (queueId: string) => void,
  onSubmitted: (receipt: AttendanceReceipt) => void,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = { root: createRoot(container), container };
  mountedDialogs.push(mounted);
  await act(async () => {
    mounted.root.render(
      <CameraCaptureDialog
        attendanceType="CHECK_IN"
        employeeId={EMPLOYEE_FIXTURE.id}
        offlineQueue={queue}
        onClose={() => undefined}
        onQueued={onQueued}
        onSubmitted={onSubmitted}
      />,
    );
    await flushMicrotasks();
  });
  return mounted;
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

afterEach(async () => {
  resolvePendingEnqueue?.(LOCAL_QUEUE_ID);
  resolvePendingEnqueue = null;
  for (const mounted of mountedDialogs.splice(0)) {
    await act(async () => {
      mounted.root.unmount();
      await flushMicrotasks();
    });
    mounted.container.remove();
  }
  for (const queue of queues.splice(0)) queue.close();
  restoreProperties();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mounted CameraCaptureDialog offline queue quota recovery', () => {
  it('preserves the selfie after quota failure and reports local queue status only after retry resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLIENT_RECORDED_AT));
    const { getUserMedia, getCurrentPosition, watchPosition, tracks, toBlob, drawImage } =
      installDeviceAndMediaMocks();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const queue = new QuotaThenAvailableQueue();
    queues.push(queue);
    const onQueued = vi.fn<(queueId: string) => void>();
    const onSubmitted = vi.fn<(receipt: AttendanceReceipt) => void>();
    const mounted = await mountDialog(queue, onQueued, onSubmitted);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: 'user' } });
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(getCurrentPosition.mock.calls[0]?.[2]).toMatchObject({
      enableHighAccuracy: true,
      maximumAge: 0,
    });
    expect(watchPosition).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector('[aria-label="Hasil pengambilan lokasi"]')?.textContent,
    ).toContain('Akurasi perangkat: 12 m');

    const video = mounted.container.querySelector('video');
    if (!video) throw new Error('Expected the mounted camera preview.');
    await act(async () => {
      video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
      await flushMicrotasks();
    });
    expect(requireButton(mounted.container, 'Ambil selfie').disabled).toBe(false);
    await clickAndFlush(requireButton(mounted.container, 'Ambil selfie'));

    expect(toBlob).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalled();
    expect(mounted.container.querySelector('img[alt*="selfie sementara"]')).not.toBeNull();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(
      requireButton(mounted.container, 'Simpan terenkripsi sebagai antrean offline'),
    ).toBeDefined();

    await clickAndFlush(
      requireButton(mounted.container, 'Simpan terenkripsi sebagai antrean offline'),
    );

    expect(queue.calls).toHaveLength(1);
    const firstCall = queue.calls[0];
    if (!firstCall) throw new Error('Expected the first queue attempt.');
    expect(firstCall.employeeId).toBe(EMPLOYEE_FIXTURE.id);
    expect(firstCall.capture).toMatchObject({
      type: 'CHECK_IN',
      clientRecordedAt: CLIENT_RECORDED_AT,
      location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12 },
    });
    expect(firstCall.capture.photo.type).toBe('image/jpeg');
    expect(firstCall.capture.photo.size).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);

    const quotaAlert = mounted.container.querySelector('[role="alert"]');
    expect(quotaAlert?.textContent).toContain(
      'Penyimpanan perangkat penuh. Absensi belum masuk antrean offline.',
    );
    expect(mounted.container.textContent).not.toMatch(/Belum tersinkron/);
    expect(mounted.container.textContent).not.toContain('Absensi tercatat');
    expect(mounted.container.textContent).not.toContain('Tercatat menunggu');
    expect(mounted.container.querySelector('[aria-label="Hasil absensi dari server"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain(LOCAL_QUEUE_ID);
    expect(onQueued).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('img[alt*="selfie sementara"]')).not.toBeNull();
    expect(
      requireButton(mounted.container, 'Simpan terenkripsi sebagai antrean offline').disabled,
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const retryResult = deferred<string>();
    resolvePendingEnqueue = retryResult.resolve;
    queue.makeAvailable(retryResult.promise);
    await clickAndFlush(
      requireButton(mounted.container, 'Simpan terenkripsi sebagai antrean offline'),
    );

    expect(queue.calls).toHaveLength(2);
    expect(mounted.container.textContent).not.toMatch(/Belum tersinkron/);
    expect(onQueued).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('img[alt*="selfie sementara"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      retryResult.resolve(LOCAL_QUEUE_ID);
      await retryResult.promise;
      await flushMicrotasks();
    });
    resolvePendingEnqueue = null;

    expect(mounted.container.textContent).toContain(
      'Belum tersinkron — tersimpan terenkripsi di perangkat',
    );
    expect(mounted.container.textContent).toContain(
      `ID antrean lokal (bukan kode bukti server): ${LOCAL_QUEUE_ID}`,
    );
    expect(mounted.container.querySelector('[aria-label="Hasil absensi dari server"]')).toBeNull();
    expect(mounted.container.querySelector('img[alt*="selfie sementara"]')).toBeNull();
    expect(onQueued).toHaveBeenCalledOnce();
    expect(onQueued).toHaveBeenCalledWith(LOCAL_QUEUE_ID);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
