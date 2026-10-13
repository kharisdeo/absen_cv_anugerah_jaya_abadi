export const LIVENESS_TIMEOUT_MS = 15_000;

export const LIVENESS_INSTRUCTIONS = ['blink', 'turn-left', 'turn-right'] as const;

export type LivenessInstruction = (typeof LIVENESS_INSTRUCTIONS)[number];

export type LivenessStatus =
  | 'idle'
  | 'awaiting-camera'
  | 'in-progress'
  | 'face-missing'
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'permission-denied'
  | 'unsupported';

export type LivenessSnapshot = Readonly<{
  status: LivenessStatus;
  instruction: LivenessInstruction | null;
  faceDetected: boolean;
  message: string;
}>;

export type LivenessFrameResult = Readonly<{
  faceDetected: boolean;
  instruction: 'pending' | 'completed' | 'failed';
}>;

/**
 * A trusted, on-device adapter must derive both values from the live video frame.
 * User input or a client flag alone must never implement this interface.
 */
export type LivenessDetector = Readonly<{
  detectFrame: (
    video: HTMLVideoElement,
    instruction: LivenessInstruction,
    signal: AbortSignal,
  ) => Promise<LivenessFrameResult>;
}>;

export type LivenessClock = Readonly<{
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}>;

export type LivenessAttemptOptions = Readonly<{
  detector?: LivenessDetector | null;
  random?: () => number;
  clock?: LivenessClock;
  timeoutMs?: number;
}>;

type LivenessListener = (snapshot: LivenessSnapshot) => void;

const DEFAULT_CLOCK: LivenessClock = {
  now: () => Date.now(),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

const INITIAL_SNAPSHOT: LivenessSnapshot = {
  status: 'idle',
  instruction: null,
  faceDetected: false,
  message: '',
};

function randomInstruction(random: () => number): LivenessInstruction {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 0.999999999)) : 0;
  return LIVENESS_INSTRUCTIONS[Math.floor(normalized * LIVENESS_INSTRUCTIONS.length)]!;
}

function isActive(status: LivenessStatus): boolean {
  return status === 'in-progress' || status === 'face-missing';
}

function statusMessage(status: LivenessStatus): string {
  switch (status) {
    case 'awaiting-camera':
      return 'Instruksi acak siap. Izinkan kamera agar pemeriksaan dapat dimulai.';
    case 'in-progress':
      return 'Ikuti instruksi. Pemeriksaan berjalan di perangkat ini; tidak ada frame video yang disimpan.';
    case 'face-missing':
      return 'Wajah belum terdeteksi pada frame kamera. Posisikan wajah di dalam bingkai dan lihat ke kamera.';
    case 'passed':
      return 'Wajah terdeteksi dan instruksi selesai pada frame langsung. Ini hasil perangkat, bukan keputusan atau status absensi dari server.';
    case 'failed':
      return 'Instruksi tidak berhasil diperiksa. Pemeriksaan dihentikan; coba lagi atau minta verifikasi.';
    case 'timeout':
      return 'Waktu pemeriksaan habis. Pemeriksaan dihentikan; coba lagi atau minta verifikasi.';
    case 'permission-denied':
      return 'Izin kamera ditolak. Tanpa kamera, pemeriksaan liveness tidak dapat dilakukan.';
    case 'unsupported':
      return 'Pemeriksaan liveness tepercaya tidak tersedia pada perangkat ini. Hasilnya hanya dapat menjadi Perlu verifikasi, bukan Valid.';
    case 'idle':
      return '';
  }
}

/**
 * Tracks one short liveness attempt without retaining image/frame data.
 * There is deliberately no default detector: the optional browser FaceDetector
 * only exposes face geometry and is not a blink/head-turn liveness detector.
 */
export class LivenessAttemptController {
  private readonly detector: LivenessDetector | null;

  private readonly random: () => number;

  private readonly clock: LivenessClock;

  private readonly timeoutMs: number;

  private readonly listeners = new Set<LivenessListener>();

  private snapshot = INITIAL_SNAPSHOT;

  private timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;

  private deadline = 0;

  private attempt = 0;

  private abortController: AbortController | null = null;

  private disposed = false;

  constructor(options: LivenessAttemptOptions = {}) {
    this.detector = options.detector ?? null;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.timeoutMs = options.timeoutMs ?? LIVENESS_TIMEOUT_MS;
  }

  getSnapshot = (): LivenessSnapshot => this.snapshot;

  subscribe(listener: LivenessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(
    status: LivenessStatus,
    instruction = this.snapshot.instruction,
    faceDetected = false,
  ) {
    this.snapshot = {
      status,
      instruction,
      faceDetected,
      message: statusMessage(status),
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) this.clock.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }

  private stopAttempt(): void {
    this.clearTimeout();
    this.abortController?.abort();
    this.abortController = null;
  }

  prepareAttempt(): void {
    if (this.disposed) return;
    this.stopAttempt();
    this.attempt += 1;
    this.abortController = new AbortController();
    this.update('awaiting-camera', randomInstruction(this.random));
  }

  cameraReady(): void {
    if (this.disposed || this.snapshot.status !== 'awaiting-camera') return;
    if (!this.detector) {
      this.finish('unsupported');
      return;
    }

    this.deadline = this.clock.now() + this.timeoutMs;
    this.update('in-progress');
    this.timeoutHandle = this.clock.setTimeout(() => this.expire(), this.timeoutMs);
  }

  permissionDenied(): void {
    if (this.snapshot.status === 'idle') this.prepareAttempt();
    this.finish('permission-denied');
  }

  deviceUnsupported(): void {
    if (this.snapshot.status === 'idle') this.prepareAttempt();
    this.finish('unsupported');
  }

  async observeFrame(video: HTMLVideoElement): Promise<void> {
    if (this.disposed || !isActive(this.snapshot.status) || !this.detector) return;
    if (this.clock.now() >= this.deadline) {
      this.finish('timeout');
      return;
    }

    const attempt = this.attempt;
    const instruction = this.snapshot.instruction;
    const signal = this.abortController?.signal;
    if (!instruction || !signal) return;

    try {
      const result = await this.detector.detectFrame(video, instruction, signal);
      if (this.disposed || attempt !== this.attempt || !isActive(this.snapshot.status)) return;
      if (this.clock.now() >= this.deadline) {
        this.finish('timeout');
      } else if (!result.faceDetected) {
        this.update('face-missing', instruction);
      } else if (result.instruction === 'failed') {
        this.finish('failed', instruction, true);
      } else if (result.instruction === 'completed') {
        this.finish('passed', instruction, true);
      } else {
        this.update('in-progress', instruction, true);
      }
    } catch {
      if (!this.disposed && attempt === this.attempt && isActive(this.snapshot.status)) {
        this.finish('unsupported', instruction);
      }
    }
  }

  private expire(): void {
    if (this.disposed || !isActive(this.snapshot.status)) return;
    const remaining = this.deadline - this.clock.now();
    if (remaining > 0) {
      this.timeoutHandle = this.clock.setTimeout(() => this.expire(), remaining);
      return;
    }
    this.finish('timeout');
  }

  private finish(
    status: Extract<
      LivenessStatus,
      'passed' | 'failed' | 'timeout' | 'permission-denied' | 'unsupported'
    >,
    instruction = this.snapshot.instruction,
    faceDetected = false,
  ): void {
    this.stopAttempt();
    this.update(status, instruction, faceDetected);
  }

  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attempt += 1;
    this.stopAttempt();
    this.listeners.clear();
  }
}
