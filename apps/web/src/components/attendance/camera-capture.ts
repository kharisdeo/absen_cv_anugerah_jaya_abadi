import {
  LivenessAttemptController,
  type LivenessAttemptOptions,
  type LivenessSnapshot,
} from './liveness.js';

export const MAX_CAPTURE_BYTES = 200 * 1024;

const MAX_FRAME_DIMENSION = 1600;
const JPEG_QUALITIES = [0.82, 0.68, 0.54, 0.4, 0.26] as const;
const IMAGE_SCALES = [1, 0.85, 0.72, 0.61, 0.52, 0.44, 0.37, 0.31, 0.25] as const;

export type CameraCaptureStatus =
  'idle' | 'requesting' | 'ready' | 'capturing' | 'captured' | 'denied' | 'not-supported' | 'error';

export type CapturedPhoto = Readonly<{
  blob: Blob;
  objectUrl: string;
  sizeBytes: number;
}>;

export type CameraCaptureSnapshot = Readonly<{
  status: CameraCaptureStatus;
  message: string;
  photo: CapturedPhoto | null;
  liveness: LivenessSnapshot;
}>;

type CameraListener = (snapshot: CameraCaptureSnapshot) => void;
type MediaDevicesApi = Pick<MediaDevices, 'getUserMedia'>;

export type CameraCaptureOptions = Readonly<{
  mediaDevices?: MediaDevicesApi | null;
  createCanvas?: () => HTMLCanvasElement;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (objectUrl: string) => void;
  liveness?: LivenessAttemptOptions;
}>;

function defaultCanvasFactory(): HTMLCanvasElement {
  return document.createElement('canvas');
}

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue releasing the remaining tracks if a browser track throws.
    }
  }
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  createCanvas: () => HTMLCanvasElement = defaultCanvasFactory,
): HTMLCanvasElement {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('Video frame is not ready.');
  }

  const dimensionScale = Math.min(
    1,
    MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight),
  );
  const frame = createCanvas();
  frame.width = Math.max(1, Math.round(video.videoWidth * dimensionScale));
  frame.height = Math.max(1, Math.round(video.videoHeight * dimensionScale));

  const context = frame.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  context.drawImage(video, 0, 0, frame.width, frame.height);
  return frame;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('JPEG encoding failed.'));
            return;
          }
          if (blob.type.toLowerCase() !== 'image/jpeg') {
            reject(new Error('JPEG encoding is not supported.'));
            return;
          }
          resolve(blob);
        },
        'image/jpeg',
        quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

export async function compressCanvasToJpeg(
  source: HTMLCanvasElement,
  createCanvas: () => HTMLCanvasElement = defaultCanvasFactory,
  maxBytes = MAX_CAPTURE_BYTES,
): Promise<Blob> {
  if (!source.width || !source.height || maxBytes < 1) {
    throw new Error('Invalid image dimensions or size limit.');
  }

  for (const scale of IMAGE_SCALES) {
    const output = createCanvas();
    output.width = Math.max(1, Math.round(source.width * scale));
    output.height = Math.max(1, Math.round(source.height * scale));

    const context = output.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(source, 0, 0, output.width, output.height);

    for (const quality of JPEG_QUALITIES) {
      const blob = await canvasToJpeg(output, quality);
      if (blob.size <= maxBytes) return blob;
    }
  }

  throw new Error('Image could not be compressed to the allowed size.');
}

function permissionWasDenied(error: unknown): boolean {
  return ['NotAllowedError', 'PermissionDeniedError'].includes(errorName(error));
}

function cameraWasNotFound(error: unknown): boolean {
  return ['NotFoundError', 'DevicesNotFoundError', 'SecurityError'].includes(errorName(error));
}

export class CameraCaptureController {
  private readonly mediaDevices: MediaDevicesApi | null;

  private readonly createCanvas: () => HTMLCanvasElement;

  private readonly createObjectUrl: (blob: Blob) => string;

  private readonly revokeObjectUrl: (objectUrl: string) => void;

  private readonly liveness: LivenessAttemptController;

  private unsubscribeLiveness: () => void = () => undefined;

  private readonly listeners = new Set<CameraListener>();

  private snapshot: CameraCaptureSnapshot = {
    status: 'idle',
    message: '',
    photo: null,
    liveness: new LivenessAttemptController().getSnapshot(),
  };

  private stream: MediaStream | null = null;

  private disposed = false;

  private operation = 0;

  constructor(options: CameraCaptureOptions = {}) {
    this.mediaDevices = Object.hasOwn(options, 'mediaDevices')
      ? (options.mediaDevices ?? null)
      : typeof navigator === 'undefined'
        ? null
        : navigator.mediaDevices;
    this.createCanvas = options.createCanvas ?? defaultCanvasFactory;
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ?? ((objectUrl) => URL.revokeObjectURL(objectUrl));
    this.liveness = new LivenessAttemptController(options.liveness);
    this.subscribeLiveness();
  }

  private subscribeLiveness(): void {
    this.unsubscribeLiveness = this.liveness.subscribe((liveness) => {
      const failed = liveness.status === 'failed' || liveness.status === 'timeout';
      if (failed) this.stopStream();
      this.snapshot = {
        ...this.snapshot,
        ...(failed && this.snapshot.status === 'ready'
          ? { status: 'error' as const, message: liveness.message, photo: null }
          : {}),
        liveness,
      };
      this.notify();
    });
  }

  getSnapshot = (): CameraCaptureSnapshot => this.snapshot;

  getStream = (): MediaStream | null => this.stream;

  subscribe(listener: CameraListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activate(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.liveness.activate();
    this.subscribeLiveness();
  }

  private update(status: CameraCaptureStatus, message: string, photo = this.snapshot.photo): void {
    this.snapshot = { ...this.snapshot, status, message, photo };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private stopStream(): void {
    const stream = this.stream;
    this.stream = null;
    if (stream) stopStreamTracks(stream);
  }

  private releasePhoto(): void {
    const photo = this.snapshot.photo;
    if (photo) this.revokeObjectUrl(photo.objectUrl);
    if (photo) this.snapshot = { ...this.snapshot, photo: null };
  }

  /** Releases the local preview and Blob after upload or a completed attempt. */
  clearCapturedPhoto(): void {
    if (this.disposed) return;
    this.releasePhoto();
    this.notify();
  }

  async start(): Promise<void> {
    if (this.disposed) return;

    const operation = ++this.operation;
    this.stopStream();
    this.releasePhoto();
    this.liveness.prepareAttempt();

    if (!this.mediaDevices?.getUserMedia) {
      this.liveness.deviceUnsupported();
      this.update(
        'not-supported',
        'Kamera tidak tersedia di browser ini atau halaman belum memakai koneksi aman (HTTPS).',
        null,
      );
      return;
    }

    this.update(
      'requesting',
      'Meminta izin kamera depan. Pilih Izinkan pada dialog browser.',
      null,
    );

    try {
      const stream = await this.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user' },
      });

      if (this.disposed || operation !== this.operation) {
        stopStreamTracks(stream);
        return;
      }

      this.stream = stream;
      this.liveness.cameraReady();
      this.update('ready', 'Kamera siap. Pastikan wajah berada di dalam bingkai.', null);
    } catch (error) {
      if (this.disposed || operation !== this.operation) return;

      if (permissionWasDenied(error)) {
        this.liveness.permissionDenied();
        this.update(
          'denied',
          'Izin kamera belum diberikan. Buka pengaturan izin situs di browser, izinkan kamera, lalu coba lagi.',
          null,
        );
      } else if (cameraWasNotFound(error)) {
        this.liveness.deviceUnsupported();
        this.update(
          'not-supported',
          'Kamera depan tidak ditemukan atau tidak dapat diakses. Periksa perangkat dan koneksi aman, lalu coba lagi.',
          null,
        );
      } else {
        this.liveness.deviceUnsupported();
        this.update(
          'error',
          'Kamera mengalami kendala atau sedang digunakan aplikasi lain. Tutup aplikasi lain, lalu coba lagi.',
          null,
        );
      }
    }
  }

  async capture(video: HTMLVideoElement): Promise<CapturedPhoto | null> {
    if (
      this.disposed ||
      this.snapshot.status !== 'ready' ||
      !['passed', 'unsupported'].includes(this.snapshot.liveness.status)
    ) {
      return null;
    }

    let frame: HTMLCanvasElement;
    try {
      frame = captureVideoFrame(video, this.createCanvas);
    } catch {
      this.stopStream();
      this.update(
        'error',
        'Frame kamera belum siap. Tutup dialog, periksa kamera, lalu coba lagi.',
        null,
      );
      return null;
    }

    const operation = ++this.operation;
    this.stopStream();
    this.update('capturing', 'Mengolah foto sementara di perangkat ini. Foto tidak dikirim.', null);

    try {
      const blob = await compressCanvasToJpeg(frame, this.createCanvas);
      if (this.disposed || operation !== this.operation) return null;

      const photo = {
        blob,
        objectUrl: this.createObjectUrl(blob),
        sizeBytes: blob.size,
      } satisfies CapturedPhoto;
      this.update(
        'captured',
        'Foto siap dilihat. Belum ada absensi yang dikirim atau dicatat.',
        photo,
      );
      return photo;
    } catch {
      if (!this.disposed && operation === this.operation) {
        this.update(
          'error',
          'Foto belum dapat diproses di bawah batas 200 KiB. Coba ambil ulang dengan pencahayaan yang cukup.',
          null,
        );
      }
      return null;
    }
  }

  async retake(): Promise<void> {
    if (this.disposed) return;
    this.releasePhoto();
    await this.start();
  }

  reportPreviewError(): void {
    if (this.disposed) return;
    this.stopStream();
    this.liveness.deviceUnsupported();
    this.update(
      'error',
      'Pratinjau kamera tidak dapat diputar. Periksa izin dan penggunaan kamera, lalu coba lagi.',
      null,
    );
  }

  async observeLivenessFrame(video: HTMLVideoElement): Promise<void> {
    if (this.disposed || this.snapshot.status !== 'ready') return;
    await this.liveness.observeFrame(video);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operation += 1;
    this.unsubscribeLiveness();
    this.unsubscribeLiveness = () => undefined;
    this.liveness.dispose();
    this.stopStream();
    this.releasePhoto();
    this.listeners.clear();
  }
}
