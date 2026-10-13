import { describe, expect, it, vi } from 'vitest';

import {
  LIVENESS_INSTRUCTIONS,
  LIVENESS_TIMEOUT_MS,
  LivenessAttemptController,
  type LivenessClock,
  type LivenessDetector,
  type LivenessFrameResult,
  type LivenessInstruction,
} from '../src/components/attendance/liveness.js';

function makeDetector(results: LivenessFrameResult[]): LivenessDetector {
  return {
    detectFrame: vi.fn(
      async (): Promise<LivenessFrameResult> =>
        results.shift() ?? { faceDetected: true, instruction: 'pending' },
    ),
  };
}

function makeClock() {
  let now = 1_000;
  let nextId = 0;
  const timeouts = new Map<number, () => void>();
  const clock: LivenessClock = {
    now: () => now,
    setTimeout: ((callback: TimerHandler) => {
      const id = ++nextId;
      if (typeof callback === 'function') timeouts.set(id, callback as () => void);
      return id;
    }) as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      timeouts.delete(id);
    }) as typeof globalThis.clearTimeout,
  };

  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const callback of [...timeouts.values()]) callback();
    },
    get pendingTimeouts() {
      return timeouts.size;
    },
  };
}

const video = {} as HTMLVideoElement;

describe('liveness attempt state machine', () => {
  it('chooses one deterministic blink or head-turn instruction for each attempt', () => {
    const samples = [0, 0.5, 0.99];
    const controller = new LivenessAttemptController({
      detector: makeDetector([]),
      random: () => samples.shift() ?? 0,
    });

    const chosen: string[] = [];
    for (let index = 0; index < LIVENESS_INSTRUCTIONS.length; index += 1) {
      controller.prepareAttempt();
      chosen.push(controller.getSnapshot().instruction ?? '');
    }

    expect(chosen).toEqual([...LIVENESS_INSTRUCTIONS]);
  });

  it('never passes a completed instruction from a frame where no face was detected', async () => {
    const controller = new LivenessAttemptController({
      detector: makeDetector([
        { faceDetected: false, instruction: 'completed' },
        { faceDetected: true, instruction: 'pending' },
      ]),
      random: () => 0,
    });
    controller.prepareAttempt();
    controller.cameraReady();

    await controller.observeFrame(video);
    expect(controller.getSnapshot().status).toBe('face-missing');
    expect(controller.getSnapshot().faceDetected).toBe(false);

    await controller.observeFrame(video);
    expect(controller.getSnapshot().status).toBe('in-progress');
    expect(controller.getSnapshot().faceDetected).toBe(true);
  });

  it('passes only when the live frame detects a face and the selected instruction completes', async () => {
    const detector = makeDetector([
      { faceDetected: false, instruction: 'completed' },
      { faceDetected: true, instruction: 'pending' },
      { faceDetected: true, instruction: 'completed' },
    ]);
    const controller = new LivenessAttemptController({ detector, random: () => 0.6 });
    controller.prepareAttempt();
    controller.cameraReady();

    await controller.observeFrame(video);
    await controller.observeFrame(video);
    expect(controller.getSnapshot().status).toBe('in-progress');

    await controller.observeFrame(video);
    expect(controller.getSnapshot().status).toBe('passed');
    expect(controller.getSnapshot().faceDetected).toBe(true);
    expect(detector.detectFrame).toHaveBeenCalledWith(
      video,
      controller.getSnapshot().instruction,
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot().message).toContain('bukan keputusan');
  });

  it('records a detector-reported failed instruction as failed', async () => {
    const controller = new LivenessAttemptController({
      detector: makeDetector([{ faceDetected: true, instruction: 'failed' }]),
      random: () => 0.2,
    });
    controller.prepareAttempt();
    controller.cameraReady();
    await controller.observeFrame(video);

    expect(controller.getSnapshot().status).toBe('failed');
    expect(controller.getSnapshot().message).toContain('tidak berhasil');
  });

  it('times out on the injected clock and aborts in-flight detection', async () => {
    const fakeClock = makeClock();
    let signal: AbortSignal | undefined;
    const detector: LivenessDetector = {
      detectFrame: vi.fn(
        (
          _video: HTMLVideoElement,
          _instruction: LivenessInstruction,
          passedSignal: AbortSignal,
        ): Promise<LivenessFrameResult> => {
          signal = passedSignal;
          return new Promise(() => undefined);
        },
      ),
    };
    const controller = new LivenessAttemptController({
      detector,
      clock: fakeClock.clock,
      timeoutMs: LIVENESS_TIMEOUT_MS,
      random: () => 0.1,
    });
    controller.prepareAttempt();
    controller.cameraReady();
    void controller.observeFrame(video);

    fakeClock.advance(LIVENESS_TIMEOUT_MS);

    expect(controller.getSnapshot().status).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    expect(fakeClock.pendingTimeouts).toBe(0);
  });

  it('fails closed as unsupported when no detector is supplied or a detector errors', async () => {
    const unavailable = new LivenessAttemptController({ random: () => 0.9 });
    unavailable.prepareAttempt();
    unavailable.cameraReady();
    expect(unavailable.getSnapshot().status).toBe('unsupported');
    expect(unavailable.getSnapshot().instruction).toBe('turn-right');
    expect(unavailable.getSnapshot().message).toContain('Perlu verifikasi');

    const broken = new LivenessAttemptController({
      detector: { detectFrame: vi.fn(async () => Promise.reject(new Error('detector error'))) },
      random: () => 0.1,
    });
    broken.prepareAttempt();
    broken.cameraReady();
    await broken.observeFrame(video);
    expect(broken.getSnapshot().status).toBe('unsupported');
  });

  it('reports camera permission denial distinctly and clears its attempt timer', () => {
    const fakeClock = makeClock();
    const controller = new LivenessAttemptController({
      detector: makeDetector([]),
      clock: fakeClock.clock,
      random: () => 0,
    });
    controller.prepareAttempt();
    controller.cameraReady();
    controller.permissionDenied();

    expect(controller.getSnapshot().status).toBe('permission-denied');
    expect(controller.getSnapshot().message).toContain('Izin kamera ditolak');
    expect(fakeClock.pendingTimeouts).toBe(0);
  });
});
