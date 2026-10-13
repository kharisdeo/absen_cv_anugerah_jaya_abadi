import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CameraCaptureDialog } from '../src/components/attendance/CameraCaptureDialog.js';
import {
  CameraCaptureController,
  MAX_CAPTURE_BYTES,
  type CameraCaptureOptions,
} from '../src/components/attendance/camera-capture.js';
import { LivenessStatusNotice } from '../src/components/attendance/CameraCaptureDialog.js';
import {
  LIVENESS_TIMEOUT_MS,
  type LivenessClock,
  type LivenessDetector,
  type LivenessFrameResult,
} from '../src/components/attendance/liveness.js';

function makeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

function makeCanvasFactory(blobSizes: number[] = []) {
  const drawCalls: Array<{ width: number; height: number }> = [];
  const encodeCalls: Array<{ type: string; quality: number | undefined }> = [];
  let canvasNumber = 0;

  function createCanvas() {
    canvasNumber += 1;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (
          _source: CanvasImageSource,
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => {
          drawCalls.push({ width, height });
        },
      }),
      toBlob: (callback: BlobCallback, type = 'image/jpeg', quality?: number) => {
        encodeCalls.push({ type, quality });
        const size = blobSizes.shift() ?? MAX_CAPTURE_BYTES + 1;
        callback(new Blob([new Uint8Array(size)], { type }));
      },
    } as unknown as HTMLCanvasElement;
    return canvas;
  }

  return {
    createCanvas,
    drawCalls,
    encodeCalls,
    get canvasCount() {
      return canvasNumber;
    },
  };
}

function makeMediaDevices(
  getUserMedia: ReturnType<typeof vi.fn>,
): NonNullable<CameraCaptureOptions['mediaDevices']> {
  return { getUserMedia } as unknown as NonNullable<CameraCaptureOptions['mediaDevices']>;
}

function makeController(
  options: {
    getUserMedia?: ReturnType<typeof vi.fn>;
    blobSizes?: number[];
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (objectUrl: string) => void;
    liveness?: CameraCaptureOptions['liveness'];
  } = {},
) {
  const canvas = makeCanvasFactory(options.blobSizes);
  const controller = new CameraCaptureController({
    ...(options.getUserMedia ? { mediaDevices: makeMediaDevices(options.getUserMedia) } : {}),
    createCanvas: canvas.createCanvas,
    createObjectUrl: options.createObjectUrl ?? (() => 'blob:camera-preview'),
    revokeObjectUrl: options.revokeObjectUrl ?? (() => undefined),
    ...(options.liveness ? { liveness: options.liveness } : {}),
  });
  return { controller, canvas };
}

function fakeVideo(width = 640, height = 480): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as HTMLVideoElement;
}

function namedError(name: string): Error {
  return Object.assign(new Error('do not expose this browser detail'), { name });
}

describe('camera capture component and local-only controller', () => {
  it('renders an opt-in camera action with no gallery picker or submit action', () => {
    const html = renderToStaticMarkup(<CameraCaptureDialog onClose={() => undefined} />);

    expect(html).toContain('<dialog');
    expect(html).toContain('Aktifkan kamera');
    expect(html).toContain('tidak ada pilihan galeri.');
    expect(html).toContain('simpanan lokal terenkripsi tetap belum tersinkron');
    expect(html).toContain('receipt server yang sah');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('Kirim absensi');
  });

  it('requests only the front camera after start, captures a frame, compresses it, and stops every track', async () => {
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      void constraints;
      return stream;
    });
    const { controller, canvas } = makeController({
      getUserMedia,
      blobSizes: [MAX_CAPTURE_BYTES + 1, MAX_CAPTURE_BYTES],
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    await controller.start();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: false,
      video: { facingMode: 'user' },
    });
    expect(controller.getSnapshot().status).toBe('ready');

    const photo = await controller.capture(fakeVideo());
    expect(photo?.sizeBytes).toBe(MAX_CAPTURE_BYTES);
    expect(photo?.blob.type).toBe('image/jpeg');
    expect(controller.getSnapshot().status).toBe('captured');
    expect(controller.getSnapshot().message).toContain('Belum ada absensi');
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(canvas.encodeCalls.map(({ type }) => type)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(canvas.encodeCalls[0]?.quality).toBeGreaterThan(canvas.encodeCalls[1]?.quality ?? 0);
    expect(canvas.canvasCount).toBeGreaterThan(1);
  });

  it('shows permission guidance and lets the employee retry successfully', async () => {
    const { stream } = makeStream();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(namedError('NotAllowedError'))
      .mockResolvedValueOnce(stream);
    const { controller } = makeController({ getUserMedia });

    await controller.start();
    expect(controller.getSnapshot().status).toBe('denied');
    expect(controller.getSnapshot().liveness.status).toBe('permission-denied');
    expect(controller.getSnapshot().message).toContain('pengaturan izin situs');
    expect(controller.getSnapshot().message).not.toContain('do not expose');

    await controller.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status).toBe('ready');
  });

  it('reports a not-supported camera state when browser media APIs are unavailable', async () => {
    const { controller } = makeController();
    await controller.start();

    expect(controller.getSnapshot().status).toBe('not-supported');
    expect(controller.getSnapshot().message).toContain('HTTPS');
    expect(controller.getSnapshot().liveness.status).toBe('unsupported');
  });

  it('releases the previous preview URL on retake and requests a fresh stream only from that action', async () => {
    const first = makeStream();
    const second = makeStream();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    const revokeObjectUrl = vi.fn();
    const { controller } = makeController({
      getUserMedia,
      blobSizes: [MAX_CAPTURE_BYTES - 2],
      revokeObjectUrl,
    });

    await controller.start();
    await controller.capture(fakeVideo());
    expect(first.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);

    await controller.retake();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:camera-preview');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status).toBe('ready');

    controller.dispose();
    for (const track of second.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('stops every active camera track when component unmount cleanup runs', async () => {
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn(async () => stream);
    const { controller } = makeController({ getUserMedia });

    await controller.start();
    controller.dispose();

    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('restores its liveness subscription if a strict-mode effect reactivates after cleanup', async () => {
    const { stream } = makeStream();
    const detector: LivenessDetector = {
      detectFrame: vi.fn(async (): Promise<LivenessFrameResult> => ({
        faceDetected: true,
        instruction: 'completed',
      })),
    };
    const { controller } = makeController({
      getUserMedia: vi.fn(async () => stream),
      liveness: { detector, random: () => 0 },
    });
    controller.activate();
    controller.dispose();
    controller.activate();
    await controller.start();
    await controller.observeLivenessFrame(fakeVideo());

    expect(controller.getSnapshot().liveness.status).toBe('passed');
  });

  it('uses the injected frame detector and requires detection before local photo capture', async () => {
    const { stream } = makeStream();
    const detector: LivenessDetector = {
      detectFrame: vi.fn(async (): Promise<LivenessFrameResult> => ({
        faceDetected: true,
        instruction: 'completed',
      })),
    };
    const { controller } = makeController({
      getUserMedia: vi.fn(async () => stream),
      blobSizes: [MAX_CAPTURE_BYTES],
      liveness: { detector, random: () => 0 },
    });
    await controller.start();

    expect(controller.getSnapshot().liveness.status).toBe('in-progress');
    expect(await controller.capture(fakeVideo())).toBeNull();
    await controller.observeLivenessFrame(fakeVideo());
    expect(controller.getSnapshot().liveness.status).toBe('passed');
    expect(await controller.capture(fakeVideo())).not.toBeNull();
  });

  it('keeps missing detector explicitly unsupported and never calls it a liveness pass', async () => {
    const { stream } = makeStream();
    const { controller } = makeController({
      getUserMedia: vi.fn(async () => stream),
      blobSizes: [MAX_CAPTURE_BYTES],
      liveness: { random: () => 0 },
    });
    await controller.start();

    expect(controller.getSnapshot().liveness.status).toBe('unsupported');
    expect(controller.getSnapshot().liveness.message).toContain('Perlu verifikasi');
    expect(controller.getSnapshot().liveness.status).not.toBe('passed');
    expect(await controller.capture(fakeVideo())).not.toBeNull();
    expect(controller.getSnapshot().liveness.status).toBe('unsupported');
  });

  it('stops all camera tracks when the detector reports liveness failure', async () => {
    const { stream, tracks } = makeStream();
    const detector: LivenessDetector = {
      detectFrame: vi.fn(async (): Promise<LivenessFrameResult> => ({
        faceDetected: true,
        instruction: 'failed',
      })),
    };
    const { controller } = makeController({
      getUserMedia: vi.fn(async () => stream),
      liveness: { detector, random: () => 0 },
    });
    await controller.start();
    await controller.observeLivenessFrame(fakeVideo());

    expect(controller.getSnapshot().liveness.status).toBe('failed');
    expect(controller.getSnapshot().status).toBe('error');
    expect(await controller.capture(fakeVideo())).toBeNull();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('stops all camera tracks when the injected clock reaches the liveness timeout', async () => {
    vi.useFakeTimers();
    try {
      const { stream, tracks } = makeStream();
      const detector: LivenessDetector = {
        detectFrame: vi.fn(async (): Promise<LivenessFrameResult> => ({
          faceDetected: true,
          instruction: 'pending',
        })),
      };
      const clock: LivenessClock = {
        now: () => Date.now(),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      };
      const { controller } = makeController({
        getUserMedia: vi.fn(async () => stream),
        liveness: { detector, clock, timeoutMs: LIVENESS_TIMEOUT_MS, random: () => 0 },
      });
      await controller.start();
      await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS);

      expect(controller.getSnapshot().liveness.status).toBe('timeout');
      expect(controller.getSnapshot().status).toBe('error');
      for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders an explicit unsupported fallback with no claim of a valid attendance', () => {
    const html = renderToStaticMarkup(
      <LivenessStatusNotice
        snapshot={{
          status: 'unsupported',
          instruction: 'blink',
          faceDetected: false,
          message:
            'Pemeriksaan liveness tepercaya tidak tersedia pada perangkat ini. Hasilnya hanya dapat menjadi Perlu verifikasi, bukan Valid.',
        }}
      />,
    );

    expect(html).toContain('Instruksi acak');
    expect(html).toContain('Berkedip satu kali');
    expect(html).toContain('Perlu verifikasi');
    expect(html).not.toContain('Valid absensi');
  });

  it('revokes the captured preview URL when component unmount cleanup runs', async () => {
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn(async () => stream);
    const revokeObjectUrl = vi.fn();
    const { controller } = makeController({
      getUserMedia,
      blobSizes: [MAX_CAPTURE_BYTES],
      revokeObjectUrl,
    });

    await controller.start();
    await controller.capture(fakeVideo());
    controller.dispose();

    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:camera-preview');
  });

  it('rejects an image that remains larger than 200 KiB after JPEG quality and resize attempts', async () => {
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn(async () => stream);
    const { controller, canvas } = makeController({ getUserMedia });

    await controller.start();
    const photo = await controller.capture(fakeVideo());

    expect(photo).toBeNull();
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().message).toContain('200 KiB');
    expect(canvas.encodeCalls.length).toBeGreaterThan(1);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });
});
