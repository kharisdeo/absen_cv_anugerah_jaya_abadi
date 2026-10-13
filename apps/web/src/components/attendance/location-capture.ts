export type CapturedLocation = Readonly<{
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}>;

export type LocationCaptureResult =
  | Readonly<{ status: 'captured'; location: CapturedLocation }>
  | Readonly<{ status: 'accuracy-poor'; bestLocation: CapturedLocation }>
  | Readonly<{ status: 'permission-denied' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{ status: 'timed-out' }>
  | Readonly<{ status: 'invalid-position' }>
  | Readonly<{ status: 'cancelled' }>;

export type LocationCaptureSnapshot = Readonly<{
  status:
    | 'idle'
    | 'capturing'
    | 'captured'
    | 'accuracy-poor'
    | 'denied'
    | 'timeout'
    | 'unavailable'
    | 'invalid'
    | 'unsupported'
    | 'error';
  location: CapturedLocation | null;
  message: string;
}>;

type PositionLike = Readonly<{
  coords: Readonly<{
    latitude: number;
    longitude: number;
    accuracy: number;
  }>;
}>;

type PositionErrorLike = Readonly<{ code: number }>;

export type GeolocationPort = Readonly<{
  getCurrentPosition: (
    success: (position: PositionLike) => void,
    failure: (error: PositionErrorLike) => void,
    options: Readonly<PositionOptions>,
  ) => void;
}>;

export type LocationCaptureOptions = Readonly<{
  /** The selected store's server-provided limit, if available; never guess it locally. */
  accuracyLimitMeters?: number;
  /** Browser API can be injected in tests; omitted value is read only when capture is invoked. */
  geolocation?: GeolocationPort | undefined;
  signal?: AbortSignal;
  /** Test seam; production always caps the total capture window at 60 seconds. */
  maxDurationMs?: number;
  /** Monotonic clock and retry delay are injectable to keep unit tests deterministic. */
  now?: () => number;
  pause?: (durationMs: number) => Promise<void>;
}>;

const MAX_CAPTURE_WINDOW_MS = 60_000;
const PER_ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_PAUSE_MS = 1_000;

function defaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function defaultPause(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isValidPosition(position: PositionLike): boolean {
  const { latitude, longitude, accuracy } = position.coords;
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    Number.isFinite(accuracy) &&
    accuracy > 0
  );
}

function toCapturedLocation(position: PositionLike): CapturedLocation {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: position.coords.accuracy,
  };
}

function requestPosition(
  geolocation: GeolocationPort,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<
  | Readonly<{ kind: 'position'; position: PositionLike }>
  | Readonly<{ kind: 'error'; code: number }>
  | Readonly<{ kind: 'cancelled' }>
> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (
      result:
        | Readonly<{ kind: 'position'; position: PositionLike }>
        | Readonly<{ kind: 'error'; code: number }>
        | Readonly<{ kind: 'cancelled' }>,
    ) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ kind: 'cancelled' });
    if (signal?.aborted) {
      finish({ kind: 'cancelled' });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      geolocation.getCurrentPosition(
        (position) => finish({ kind: 'position', position }),
        (error) => finish({ kind: 'error', code: error.code }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    } catch {
      finish({ kind: 'error', code: 2 });
    }
  });
}

/**
 * Capture one location only when explicitly invoked by the attendance action.
 * Coordinates stay in memory; this module never persists, logs, or geofences them.
 */
export async function captureCurrentLocation(
  options: LocationCaptureOptions = {},
): Promise<LocationCaptureResult> {
  let geolocation = options.geolocation;
  try {
    geolocation ??= typeof navigator === 'undefined' ? undefined : navigator.geolocation;
  } catch {
    return { status: 'unavailable' };
  }
  if (!geolocation) return { status: 'unsupported' };
  if (options.signal?.aborted) return { status: 'cancelled' };

  const now = options.now ?? defaultMonotonicNow;
  const pause = options.pause ?? defaultPause;
  const requestedWindow = options.maxDurationMs ?? MAX_CAPTURE_WINDOW_MS;
  const durationMs = Math.min(MAX_CAPTURE_WINDOW_MS, Math.max(0, requestedWindow));
  const deadline = now() + durationMs;
  let bestLocation: CapturedLocation | undefined;
  let sawInvalidPosition = false;
  let sawUnavailable = false;
  let sawTimeout = false;

  while (now() < deadline) {
    if (options.signal?.aborted) return { status: 'cancelled' };

    const remainingMs = deadline - now();
    const result = await requestPosition(
      geolocation,
      Math.min(PER_ATTEMPT_TIMEOUT_MS, Math.max(1, remainingMs)),
      options.signal,
    );
    if (result.kind === 'cancelled') return { status: 'cancelled' };

    if (result.kind === 'position') {
      if (!isValidPosition(result.position)) {
        sawInvalidPosition = true;
      } else {
        const location = toCapturedLocation(result.position);
        if (!bestLocation || location.accuracyMeters < bestLocation.accuracyMeters) {
          bestLocation = location;
        }
        if (
          options.accuracyLimitMeters === undefined ||
          location.accuracyMeters <= options.accuracyLimitMeters
        ) {
          return { status: 'captured', location };
        }
      }
    } else if (result.code === 1) {
      return { status: 'permission-denied' };
    } else if (result.code === 3) {
      sawTimeout = true;
    } else {
      sawUnavailable = true;
    }

    const waitMs = Math.min(RETRY_PAUSE_MS, Math.max(0, deadline - now()));
    if (waitMs > 0) await pause(waitMs);
  }

  if (options.signal?.aborted) return { status: 'cancelled' };
  if (bestLocation) return { status: 'accuracy-poor', bestLocation };
  if (sawInvalidPosition) return { status: 'invalid-position' };
  if (sawUnavailable && !sawTimeout) return { status: 'unavailable' };
  return { status: 'timed-out' };
}

const idleSnapshot: LocationCaptureSnapshot = {
  status: 'idle',
  location: null,
  message: '',
};

/** Memory-only state controller; constructing/subscribing never touches geolocation. */
export class LocationCaptureController {
  private snapshot: LocationCaptureSnapshot = idleSnapshot;
  private readonly listeners = new Set<(snapshot: LocationCaptureSnapshot) => void>();
  private activeController: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: LocationCaptureOptions = {}) {}

  getSnapshot(): LocationCaptureSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: LocationCaptureSnapshot) => void): () => void {
    // React Strict Mode replays effect setup/cleanup during development while
    // preserving state; the next live subscription reactivates the controller.
    if (this.disposed) this.disposed = false;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.disposed || this.activeController) return;

    const controller = new AbortController();
    this.activeController = controller;
    const externalSignal = this.options.signal;
    const forwardExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });

    this.publish({
      status: 'capturing',
      location: null,
      message: 'Mengambil lokasi perangkat untuk pemeriksaan absensi…',
    });

    void captureCurrentLocation({ ...this.options, signal: controller.signal })
      .then((result) => {
        if (this.disposed || this.activeController !== controller) return;
        this.activeController = null;
        this.publish(this.toSnapshot(result));
      })
      .catch(() => {
        if (this.disposed || this.activeController !== controller) return;
        this.activeController = null;
        this.publish({
          status: 'error',
          location: null,
          message: 'Lokasi tidak dapat diproses. Coba lagi dari tombol absensi.',
        });
      })
      .finally(() => externalSignal?.removeEventListener('abort', forwardExternalAbort));
  }

  cancel(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.publish(idleSnapshot);
  }

  reset(): void {
    this.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeController?.abort();
    this.activeController = null;
    this.listeners.clear();
    this.snapshot = idleSnapshot;
  }

  private publish(snapshot: LocationCaptureSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private toSnapshot(result: LocationCaptureResult): LocationCaptureSnapshot {
    switch (result.status) {
      case 'captured':
        return {
          status: 'captured',
          location: result.location,
          message: 'Lokasi diperoleh. Menunggu validasi lokasi dari server.',
        };
      case 'accuracy-poor':
        return {
          status: 'accuracy-poor',
          location: result.bestLocation,
          message:
            'Akurasi GPS belum mencapai batas toko; lokasi terbaik menunggu penilaian server.',
        };
      case 'permission-denied':
        return {
          status: 'denied',
          location: null,
          message: 'Izin lokasi ditolak. Aktifkan lokasi untuk mencoba kembali.',
        };
      case 'unavailable':
        return {
          status: 'unavailable',
          location: null,
          message: 'Lokasi perangkat belum tersedia. Periksa GPS lalu coba lagi.',
        };
      case 'unsupported':
        return {
          status: 'unsupported',
          location: null,
          message: 'Browser ini tidak mendukung pengambilan lokasi perangkat.',
        };
      case 'timed-out':
        return {
          status: 'timeout',
          location: null,
          message:
            'Lokasi belum didapatkan dalam 60 detik. Coba lagi di area dengan sinyal GPS lebih baik.',
        };
      case 'invalid-position':
        return {
          status: 'invalid',
          location: null,
          message: 'Perangkat memberikan data lokasi yang tidak valid. Coba lagi.',
        };
      case 'cancelled':
        return idleSnapshot;
    }
  }
}
