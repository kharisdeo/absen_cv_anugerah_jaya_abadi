// @vitest-environment happy-dom

import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CameraCaptureDialog } from '../src/components/attendance/CameraCaptureDialog.js';

type MountedHarness = Readonly<{ root: Root; container: HTMLDivElement }>;
type SavedDescriptor = Readonly<{
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}>;

const mountedHarnesses: MountedHarness[] = [];
const savedDescriptors: SavedDescriptor[] = [];
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

function AttendanceActionHarness() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button onClick={() => setDialogOpen(true)} type="button">
        Absen masuk
      </button>
      {dialogOpen && <CameraCaptureDialog onClose={() => setDialogOpen(false)} />}
    </>
  );
}

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

function makeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

function installDeviceMocks(getUserMedia: ReturnType<typeof vi.fn>) {
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
        timestamp: 1,
      } as GeolocationPosition);
    },
  );
  const watchPosition = vi.fn();

  replaceProperty(navigator, 'mediaDevices', { getUserMedia });
  replaceProperty(navigator, 'geolocation', {
    getCurrentPosition,
    watchPosition,
  });

  return { getCurrentPosition, watchPosition };
}

function installDialogAndVideoShims() {
  replaceProperty(HTMLDialogElement.prototype, 'showModal', function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  replaceProperty(HTMLDialogElement.prototype, 'close', function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  replaceProperty(HTMLVideoElement.prototype, 'srcObject', null);
  replaceProperty(HTMLMediaElement.prototype, 'play', () => Promise.resolve());
}

async function mountHarness(): Promise<MountedHarness> {
  const container = document.createElement('div');
  document.body.append(container);
  const harness = { root: createRoot(container), container };
  mountedHarnesses.push(harness);
  await act(async () => {
    harness.root.render(<AttendanceActionHarness />);
  });
  return harness;
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`Expected button: ${label}`);
  return button;
}

async function clickAndFlush(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(() => {
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
  for (const harness of mountedHarnesses.splice(0)) {
    await act(async () => {
      harness.root.unmount();
    });
    harness.container.remove();
  }
  restoreProperties();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mounted CameraCaptureDialog', () => {
  it('requests front camera and one-shot high-accuracy location only after an attendance action', async () => {
    installDialogAndVideoShims();
    const { stream } = makeStream();
    const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
    getUserMedia.mockResolvedValue(stream);
    const { getCurrentPosition, watchPosition } = installDeviceMocks(getUserMedia);

    const staticMarkup = renderToStaticMarkup(<CameraCaptureDialog onClose={() => undefined} />);
    expect(staticMarkup).toContain('<dialog');
    expect(staticMarkup).not.toContain('type="file"');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    const harness = await mountHarness();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    await clickAndFlush(requireButton(harness.container, 'Absen masuk'));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: 'user' },
    });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(getCurrentPosition.mock.calls[0]?.[2]).toMatchObject({
      enableHighAccuracy: true,
      maximumAge: 0,
    });
    expect(watchPosition).not.toHaveBeenCalled();
    expect(harness.container.querySelector('dialog input[type="file"]')).toBeNull();
    expect(harness.container.querySelector('video')).not.toBeNull();

    await clickAndFlush(requireButton(harness.container, 'Tutup kamera'));

    expect(harness.container.querySelector('dialog')).toBeNull();
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('shows safe permission guidance, retries successfully, and stops tracks on unmount', async () => {
    installDialogAndVideoShims();
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
    getUserMedia
      .mockRejectedValueOnce(
        Object.assign(new Error('raw browser detail must stay hidden'), {
          name: 'NotAllowedError',
        }),
      )
      .mockResolvedValueOnce(stream);
    const { getCurrentPosition } = installDeviceMocks(getUserMedia);
    const harness = await mountHarness();

    await clickAndFlush(requireButton(harness.container, 'Absen masuk'));

    const alert = harness.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Izin kamera diperlukan');
    expect(alert?.textContent).toContain('pengaturan izin situs');
    expect(alert?.textContent).not.toContain('raw browser detail must stay hidden');
    expect(alert?.textContent).not.toContain('NotAllowedError');
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    await clickAndFlush(requireButton(harness.container, 'Coba lagi'));

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.container.querySelector('video')).not.toBeNull();
    expect(harness.container.querySelector('dialog input[type="file"]')).toBeNull();

    await act(async () => {
      harness.root.unmount();
    });
    harness.container.remove();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });
});
