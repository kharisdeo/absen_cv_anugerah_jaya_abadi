// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ReviewerRequestDto,
  ReviewerRole,
  SignedRequestAttachment,
} from '../src/api/attendance-review-api.js';
import { RequestReviewDetail } from '../src/pages/RequestReviewPage.js';

type AttachmentGetter = (
  requestId: string,
  signal?: AbortSignal,
) => Promise<SignedRequestAttachment>;

type MountedDetail = Readonly<{
  root: Root;
  container: HTMLDivElement;
  unmounted: { value: boolean };
}>;

const employeeId = '00000000-0000-4000-8000-000000000902';
const doctorNote: SignedRequestAttachment = {
  url: 'https://files.example.test/doctor-note?signature=synthetic-only',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
};
const sickRequest: ReviewerRequestDto = {
  id: '00000000-0000-4000-8000-000000000907',
  employee: { id: employeeId, fullName: 'Karyawan Contoh' },
  requestType: 'SICK',
  startDate: '2026-10-11',
  endDate: '2026-10-11',
  reason: 'Perlu istirahat sesuai anjuran dokter',
  status: 'PENDING',
  requestedAt: '2026-10-11T00:00:00.000Z',
  decisionAt: null,
  decisionNote: null,
  hasAttachment: true,
  requestedOvertimeMinutes: null,
  approvedOvertimeMinutes: 0,
};

const mountedDetails: MountedDetail[] = [];

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

afterEach(async () => {
  for (const detail of mountedDetails) {
    if (detail.unmounted.value) continue;
    await act(async () => {
      detail.root.unmount();
    });
    detail.unmounted.value = true;
    detail.container.remove();
  }
  mountedDetails.length = 0;
  vi.useRealTimers();
});

function renderDetail(
  detail: MountedDetail,
  request: ReviewerRequestDto,
  role: ReviewerRole,
  onGetAttachmentUrl: AttachmentGetter,
) {
  detail.root.render(
    <RequestReviewDetail
      onDecision={async () => undefined}
      onGetAttachmentUrl={onGetAttachmentUrl}
      request={request}
      role={role}
      submitting={false}
    />,
  );
}

async function mountDetail(
  request: ReviewerRequestDto,
  role: ReviewerRole,
  onGetAttachmentUrl: AttachmentGetter,
): Promise<MountedDetail> {
  const container = document.createElement('div');
  document.body.append(container);
  const detail: MountedDetail = {
    root: createRoot(container),
    container,
    unmounted: { value: false },
  };
  mountedDetails.push(detail);
  await act(async () => {
    renderDetail(detail, request, role, onGetAttachmentUrl);
  });
  return detail;
}

async function rerenderDetail(
  detail: MountedDetail,
  request: ReviewerRequestDto,
  role: ReviewerRole,
  onGetAttachmentUrl: AttachmentGetter,
) {
  await act(async () => {
    renderDetail(detail, request, role, onGetAttachmentUrl);
  });
}

async function unmountDetail(detail: MountedDetail) {
  if (detail.unmounted.value) return;
  await act(async () => {
    detail.root.unmount();
  });
  detail.unmounted.value = true;
  detail.container.remove();
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = findButton(container, label);
  if (!button) throw new Error(`Expected button: ${label}`);
  return button;
}

async function clickAndFlush(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const eligibilityCases: ReadonlyArray<
  Readonly<{
    label: string;
    request: ReviewerRequestDto;
    role: ReviewerRole;
    eligible: boolean;
  }>
> = [
  {
    label: 'Admin with attached sick request',
    request: sickRequest,
    role: 'ADMIN',
    eligible: true,
  },
  {
    label: 'Supervisor with attached sick request',
    request: sickRequest,
    role: 'SUPERVISOR',
    eligible: true,
  },
  {
    label: 'Admin with sick request without attachment',
    request: { ...sickRequest, hasAttachment: false },
    role: 'ADMIN',
    eligible: false,
  },
  {
    label: 'Supervisor with sick request without attachment',
    request: { ...sickRequest, hasAttachment: false },
    role: 'SUPERVISOR',
    eligible: false,
  },
  {
    label: 'Admin with a leave request and attachment',
    request: { ...sickRequest, requestType: 'LEAVE' },
    role: 'ADMIN',
    eligible: false,
  },
  {
    label: 'Supervisor with an annual-leave request and attachment',
    request: { ...sickRequest, requestType: 'ANNUAL_LEAVE' },
    role: 'SUPERVISOR',
    eligible: false,
  },
  {
    label: 'Admin with an overtime request and attachment',
    request: { ...sickRequest, requestType: 'OVERTIME' },
    role: 'ADMIN',
    eligible: false,
  },
];

describe('mounted reviewer doctor-note download', () => {
  it.each(eligibilityCases)('$label', async ({ request, role, eligible }) => {
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>(async () => doctorNote);
    const detail = await mountDetail(request, role, onGetAttachmentUrl);
    const button = findButton(detail.container, 'Siapkan tautan unduh');

    expect(onGetAttachmentUrl).not.toHaveBeenCalled();
    expect(button !== null).toBe(eligible);

    if (eligible && button) {
      await clickAndFlush(button);
      expect(onGetAttachmentUrl).toHaveBeenCalledTimes(1);
      expect(onGetAttachmentUrl).toHaveBeenCalledWith(request.id, expect.any(AbortSignal));
    }
  });

  it('disables the loading action and ignores rapid duplicate clicks', async () => {
    const pending = deferred<SignedRequestAttachment>();
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>(() => pending.promise);
    const detail = await mountDetail(sickRequest, 'ADMIN', onGetAttachmentUrl);
    const button = requireButton(detail.container, 'Siapkan tautan unduh');

    await act(async () => {
      button.click();
      button.click();
    });

    expect(onGetAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(detail.container.textContent).toContain('Meminta tautan unduh surat dokter');
    expect(requireButton(detail.container, 'Menyiapkan tautan unduh…').disabled).toBe(true);

    await act(async () => {
      pending.resolve(doctorNote);
      await pending.promise;
    });
  });

  it('renders a safe temporary link without showing or previewing the signed URL', async () => {
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>(async () => doctorNote);
    const detail = await mountDetail(sickRequest, 'ADMIN', onGetAttachmentUrl);

    await clickAndFlush(requireButton(detail.container, 'Siapkan tautan unduh'));

    const link = detail.container.querySelector<HTMLAnchorElement>('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(doctorNote.url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(link?.textContent).toBe('Unduh surat dokter');
    expect(detail.container.textContent).not.toContain(doctorNote.url);
    expect(detail.container.textContent).not.toContain('signature=synthetic-only');
    expect(detail.container.querySelector('img, picture, object, embed, iframe, video')).toBeNull();
  });

  it('shows a safe error and retries only after a manual click', async () => {
    const onGetAttachmentUrl = vi
      .fn<AttachmentGetter>()
      .mockRejectedValueOnce(new Error('private URL signature=synthetic-only'))
      .mockResolvedValueOnce(doctorNote);
    const detail = await mountDetail(sickRequest, 'ADMIN', onGetAttachmentUrl);

    await clickAndFlush(requireButton(detail.container, 'Siapkan tautan unduh'));

    expect(detail.container.textContent).toContain('Permintaan belum dapat diproses.');
    expect(detail.container.textContent).not.toContain('synthetic-only');
    expect(onGetAttachmentUrl).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });
    expect(onGetAttachmentUrl).toHaveBeenCalledTimes(1);

    await clickAndFlush(requireButton(detail.container, 'Coba lagi'));
    expect(onGetAttachmentUrl).toHaveBeenCalledTimes(2);
    expect(detail.container.querySelector('a')?.getAttribute('href')).toBe(doctorNote.url);
  });

  it('removes the href and shows expired state when the deterministic timer elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T05:00:00.000Z'));
    const attachment = {
      ...doctorNote,
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>(async () => attachment);
    const detail = await mountDetail(sickRequest, 'ADMIN', onGetAttachmentUrl);

    await clickAndFlush(requireButton(detail.container, 'Siapkan tautan unduh'));
    expect(detail.container.querySelector('a')?.getAttribute('href')).toBe(attachment.url);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(detail.container.querySelector('a')).toBeNull();
    expect(detail.container.textContent).toContain('Tautan unduh kedaluwarsa');
    expect(detail.container.textContent).not.toContain('signature=synthetic-only');
  });

  it('drops a ready URL when the selected request changes', async () => {
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>(async () => doctorNote);
    const detail = await mountDetail(sickRequest, 'SUPERVISOR', onGetAttachmentUrl);

    await clickAndFlush(requireButton(detail.container, 'Siapkan tautan unduh'));
    expect(detail.container.querySelector('a')?.getAttribute('href')).toBe(doctorNote.url);

    const nextRequest = { ...sickRequest, id: '00000000-0000-4000-8000-000000000908' };
    await rerenderDetail(detail, nextRequest, 'SUPERVISOR', onGetAttachmentUrl);

    expect(detail.container.querySelector('a')).toBeNull();
    expect(findButton(detail.container, 'Siapkan tautan unduh')).not.toBeNull();
    expect(detail.container.textContent).not.toContain('signature=synthetic-only');
  });

  it('aborts a request on request change and ignores its late result', async () => {
    const first = deferred<SignedRequestAttachment>();
    const second = deferred<SignedRequestAttachment>();
    const onGetAttachmentUrl = vi.fn<AttachmentGetter>((requestId) =>
      requestId === sickRequest.id ? first.promise : second.promise,
    );
    const detail = await mountDetail(sickRequest, 'ADMIN', onGetAttachmentUrl);

    await act(async () => {
      requireButton(detail.container, 'Siapkan tautan unduh').click();
    });
    const firstSignal = onGetAttachmentUrl.mock.calls[0]?.[1];
    expect(firstSignal?.aborted).toBe(false);

    const nextRequest = { ...sickRequest, id: '00000000-0000-4000-8000-000000000909' };
    await rerenderDetail(detail, nextRequest, 'ADMIN', onGetAttachmentUrl);
    expect(firstSignal?.aborted).toBe(true);
    expect(detail.container.querySelector('a')).toBeNull();

    const staleAttachment = {
      ...doctorNote,
      url: 'https://files.example.test/stale?signature=synthetic-stale',
    };
    await act(async () => {
      first.resolve(staleAttachment);
      await first.promise;
    });
    expect(detail.container.querySelector('a')).toBeNull();
    expect(detail.container.textContent).not.toContain('synthetic-stale');

    await act(async () => {
      requireButton(detail.container, 'Siapkan tautan unduh').click();
    });
    expect(onGetAttachmentUrl).toHaveBeenCalledTimes(2);
    expect(onGetAttachmentUrl.mock.calls[1]?.[0]).toBe(nextRequest.id);
    await act(async () => {
      second.resolve(doctorNote);
      await second.promise;
    });
    expect(detail.container.querySelector('a')?.getAttribute('href')).toBe(doctorNote.url);
  });

  it('removes a ready URL on unmount and aborts an active request', async () => {
    const readyGetter = vi.fn<AttachmentGetter>(async () => doctorNote);
    const readyDetail = await mountDetail(sickRequest, 'ADMIN', readyGetter);
    await clickAndFlush(requireButton(readyDetail.container, 'Siapkan tautan unduh'));
    expect(readyDetail.container.querySelector('a')?.getAttribute('href')).toBe(doctorNote.url);
    await unmountDetail(readyDetail);
    expect(readyDetail.container.querySelector('a')).toBeNull();
    expect(readyDetail.container.textContent).toBe('');

    const pending = deferred<SignedRequestAttachment>();
    const pendingGetter = vi.fn<AttachmentGetter>(() => pending.promise);
    const pendingDetail = await mountDetail(sickRequest, 'SUPERVISOR', pendingGetter);
    await act(async () => {
      requireButton(pendingDetail.container, 'Siapkan tautan unduh').click();
    });
    const signal = pendingGetter.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    await unmountDetail(pendingDetail);
    expect(signal?.aborted).toBe(true);
    expect(pendingDetail.container.querySelector('a')).toBeNull();
    await act(async () => {
      pending.resolve(doctorNote);
      await pending.promise;
    });
  });
});
