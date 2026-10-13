import { describe, expect, it, vi } from 'vitest';

import {
  captureCurrentLocation,
  LocationCaptureController,
  type GeolocationPort,
} from '../src/components/attendance/location-capture.js';

function position(latitude: number, longitude: number, accuracy: number) {
  return { coords: { latitude, longitude, accuracy } };
}

function successfulGeolocation(fixes: ReadonlyArray<ReturnType<typeof position>>): GeolocationPort {
  let index = 0;
  return {
    getCurrentPosition(success) {
      const fix = fixes[Math.min(index, fixes.length - 1)];
      index += 1;
      if (!fix) throw new Error('No test fix configured');
      success(fix);
    },
  };
}

describe('attendance location capture', () => {
  it('uses high accuracy and returns a valid fix without exposing raw coordinates in messages', async () => {
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>((success) => {
      success(position(-6.2, 106.8, 12));
    });
    const result = await captureCurrentLocation({
      geolocation: { getCurrentPosition },
      accuracyLimitMeters: 30,
    });

    expect(result).toEqual({
      status: 'captured',
      location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12 },
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: expect.any(Number),
    });
  });

  it('returns immediately for denied permission without retrying', async () => {
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>((_success, failure) => {
      failure({ code: 1 });
    });
    const result = await captureCurrentLocation({
      geolocation: { getCurrentPosition },
      maxDurationMs: 20_000,
      pause: async () => {},
    });

    expect(result).toEqual({ status: 'permission-denied' });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('retries an unavailable fix, then accepts a better-quality result within the total window', async () => {
    let now = 0;
    let calls = 0;
    const geolocation: GeolocationPort = {
      getCurrentPosition(success, failure) {
        calls += 1;
        if (calls === 1) failure({ code: 2 });
        else success(position(-6.2, 106.8, 20));
      },
    };
    const result = await captureCurrentLocation({
      geolocation,
      accuracyLimitMeters: 30,
      maxDurationMs: 60_000,
      now: () => now,
      pause: async (duration) => {
        now += duration;
      },
    });

    expect(result).toMatchObject({ status: 'captured', location: { accuracyMeters: 20 } });
    expect(calls).toBe(2);
  });

  it('keeps the best weak-accuracy fix in memory and does not invent a store accuracy limit', async () => {
    const result = await captureCurrentLocation({
      geolocation: successfulGeolocation([position(-6.2, 106.8, 42)]),
    });

    expect(result).toMatchObject({ status: 'captured', location: { accuracyMeters: 42 } });

    let now = 0;
    const poorResult = await captureCurrentLocation({
      geolocation: successfulGeolocation([position(-6.2, 106.8, 42)]),
      accuracyLimitMeters: 30,
      maxDurationMs: 500,
      now: () => now,
      pause: async (duration) => {
        now += duration;
      },
    });
    expect(poorResult).toEqual({
      status: 'accuracy-poor',
      bestLocation: { latitude: -6.2, longitude: 106.8, accuracyMeters: 42 },
    });
  });

  it('retries browser timeout only within the 60-second cap', async () => {
    let now = 0;
    let calls = 0;
    const timeouts: number[] = [];
    const geolocation: GeolocationPort = {
      getCurrentPosition(_success, failure, options) {
        calls += 1;
        timeouts.push(options.timeout ?? -1);
        failure({ code: 3 });
      },
    };
    const result = await captureCurrentLocation({
      geolocation,
      maxDurationMs: 120_000,
      now: () => now,
      pause: async (duration) => {
        now += duration + 10_000;
      },
    });

    expect(result).toEqual({ status: 'timed-out' });
    expect(calls).toBe(6);
    expect(timeouts.every((timeout) => timeout <= 10_000)).toBe(true);
  });

  it('ignores invalid browser coordinates and reports invalid-position without persisting them', async () => {
    let now = 0;
    const result = await captureCurrentLocation({
      geolocation: successfulGeolocation([position(91, 106.8, 10)]),
      maxDurationMs: 500,
      now: () => now,
      pause: async (duration) => {
        now += duration;
      },
    });

    expect(result).toEqual({ status: 'invalid-position' });
  });

  it('does not start a geolocation request when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>();

    await expect(
      captureCurrentLocation({ geolocation: { getCurrentPosition }, signal: controller.signal }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('does not request location on controller construction or subscription', () => {
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>();
    const controller = new LocationCaptureController({ geolocation: { getCurrentPosition } });
    const unsubscribe = controller.subscribe(() => {});

    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', location: null });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    unsubscribe();
    controller.dispose();
  });

  it('starts only when explicitly invoked and exposes accuracy but never coordinates in status text', async () => {
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>((success) => {
      success(position(-6.2, 106.8, 12));
    });
    const watchPosition = vi.fn();
    const controller = new LocationCaptureController({
      geolocation: { getCurrentPosition, watchPosition } as unknown as GeolocationPort,
    });
    const snapshots: Array<ReturnType<LocationCaptureController['getSnapshot']>> = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot));

    expect(snapshots).toHaveLength(0);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    controller.start();
    controller.start();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(watchPosition).not.toHaveBeenCalled();
    expect(snapshots[0]).toMatchObject({ status: 'capturing' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot()).toMatchObject({
      status: 'captured',
      location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12 },
    });
    expect(controller.getSnapshot().message).not.toContain('-6.2');
    expect(controller.getSnapshot().message).not.toContain('106.8');
    controller.dispose();
  });

  it('clears the in-memory snapshot on cancel and ignores a late browser callback', async () => {
    let lateSuccess: ((value: ReturnType<typeof position>) => void) | undefined;
    const controller = new LocationCaptureController({
      geolocation: {
        getCurrentPosition(success) {
          lateSuccess = success;
        },
      },
    });
    controller.start();
    controller.cancel();
    lateSuccess?.(position(-6.2, 106.8, 12));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', location: null });
    controller.dispose();
  });

  it('cancels while waiting to retry and makes no second location request', async () => {
    const controller = new AbortController();
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>((_success, failure) => {
      failure({ code: 2 });
    });

    await expect(
      captureCurrentLocation({
        geolocation: { getCurrentPosition },
        signal: controller.signal,
        maxDurationMs: 10_000,
        pause: async () => {
          controller.abort();
        },
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('can resubscribe after a strict-mode cleanup cycle without retaining a prior fix', async () => {
    const getCurrentPosition = vi.fn<GeolocationPort['getCurrentPosition']>((success) => {
      success(position(-6.2, 106.8, 12));
    });
    const controller = new LocationCaptureController({ geolocation: { getCurrentPosition } });
    const firstUnsubscribe = controller.subscribe(() => {});
    firstUnsubscribe();
    controller.dispose();
    const secondUnsubscribe = controller.subscribe(() => {});

    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', location: null });
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().status).toBe('captured');
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    secondUnsubscribe();
    controller.dispose();
  });

  it('returns unavailable when the browser does not support geolocation', async () => {
    await expect(captureCurrentLocation({ geolocation: undefined })).resolves.toEqual({
      status: 'unsupported',
    });
  });
});
