// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttendanceRequestCreateInput } from '../src/api/attendance-requests-api.js';
import { EmployeeRequestForm } from '../src/pages/EmployeeRequestsPage.js';

type SubmitRequest = (input: AttendanceRequestCreateInput) => Promise<void>;
type MountedForm = Readonly<{ root: Root; container: HTMLDivElement }>;

const mountedForms: MountedForm[] = [];
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterEach(async () => {
  for (const form of mountedForms.splice(0)) {
    await act(async () => {
      form.root.unmount();
    });
    form.container.remove();
  }
});

afterAll(() => {
  if (originalActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function mountForm(onSubmit: SubmitRequest): Promise<MountedForm> {
  const container = document.createElement('div');
  document.body.append(container);
  const form = { root: createRoot(container), container };
  mountedForms.push(form);
  await act(async () => {
    form.root.render(<EmployeeRequestForm onSubmit={onSubmit} />);
  });
  return form;
}

function requireForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>('form.employee-request-form');
  if (!form) throw new Error('Expected employee request form');
  return form;
}

function requireField<T extends HTMLInputElement | HTMLTextAreaElement>(
  container: HTMLElement,
  selector: string,
): T {
  const field = container.querySelector<T>(selector);
  if (!field) throw new Error(`Expected form field: ${selector}`);
  return field;
}

function requireSubmitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'form.employee-request-form button[type="submit"]',
  );
  if (!button) throw new Error('Expected employee request submit button');
  return button;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Expected native value setter');
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function expectAccessibleFieldError(
  container: HTMLElement,
  selector: string,
  message: string,
): void {
  const field = requireField<HTMLInputElement | HTMLTextAreaElement>(container, selector);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  const describedBy = field.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
  const error = Array.from(container.querySelectorAll<HTMLElement>('[role="alert"]')).find(
    (candidate) => candidate.id !== '' && describedBy.includes(candidate.id),
  );
  expect(error?.textContent).toBe(message);
}

async function fillValidLeaveForm(container: HTMLElement): Promise<void> {
  await act(async () => {
    setFieldValue(
      requireField<HTMLInputElement>(container, '#employee-request-start-date'),
      '2026-10-12',
    );
    setFieldValue(
      requireField<HTMLInputElement>(container, '#employee-request-end-date'),
      '2026-10-13',
    );
    setFieldValue(requireField<HTMLTextAreaElement>(container, 'textarea'), 'Keperluan keluarga');
  });
}

describe('EmployeeRequestForm interactive DOM behavior', () => {
  it('shows accessible errors for empty and invalid date-range submissions without calling onSubmit', async () => {
    const onSubmit = vi.fn<SubmitRequest>(async () => undefined);
    const form = await mountForm(onSubmit);

    await act(async () => {
      requireForm(form.container).requestSubmit();
    });

    expectAccessibleFieldError(
      form.container,
      '#employee-request-start-date',
      'Masukkan tanggal kalender yang valid.',
    );
    expectAccessibleFieldError(
      form.container,
      '#employee-request-end-date',
      'Masukkan tanggal kalender yang valid.',
    );
    expectAccessibleFieldError(form.container, 'textarea', 'Alasan wajib diisi.');
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      setFieldValue(
        requireField<HTMLInputElement>(form.container, '#employee-request-start-date'),
        '2026-10-13',
      );
      setFieldValue(
        requireField<HTMLInputElement>(form.container, '#employee-request-end-date'),
        '2026-10-12',
      );
      setFieldValue(
        requireField<HTMLTextAreaElement>(form.container, 'textarea'),
        'Keperluan keluarga',
      );
      requireForm(form.container).requestSubmit();
    });

    expectAccessibleFieldError(
      form.container,
      '#employee-request-end-date',
      'Tanggal akhir tidak boleh sebelum tanggal mulai.',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a valid LEAVE once during rapid duplicate submits, then shows success and resets fields', async () => {
    const pendingSubmit = deferred<void>();
    const onSubmit = vi.fn<SubmitRequest>(() => pendingSubmit.promise);
    const form = await mountForm(onSubmit);
    await fillValidLeaveForm(form.container);

    await act(async () => {
      const element = requireForm(form.container);
      element.requestSubmit();
      element.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      requestType: 'LEAVE',
      startDate: '2026-10-12',
      endDate: '2026-10-13',
      reason: 'Keperluan keluarga',
    });
    expect(requireSubmitButton(form.container).disabled).toBe(true);
    expect(requireSubmitButton(form.container).textContent).toContain('Mengirim pengajuan…');

    await act(async () => {
      pendingSubmit.resolve();
      await pendingSubmit.promise;
    });

    const success = Array.from(
      form.container.querySelectorAll<HTMLElement>('[role="status"]'),
    ).find((candidate) => candidate.textContent?.includes('Pengajuan berhasil dikirim.'));
    expect(success).toBeDefined();
    expect(
      requireField<HTMLInputElement>(form.container, '#employee-request-start-date').value,
    ).toBe('');
    expect(requireField<HTMLInputElement>(form.container, '#employee-request-end-date').value).toBe(
      '',
    );
    expect(requireField<HTMLTextAreaElement>(form.container, 'textarea').value).toBe('');
  });

  it('shows a safe API error and keeps entered values available for retry', async () => {
    const serverDetail = 'SENTINEL-PRIVATE-SERVER-DETAIL';
    const onSubmit = vi.fn<SubmitRequest>(async () => {
      throw { code: 'INTERNAL_SERVER_ERROR', detail: serverDetail };
    });
    const form = await mountForm(onSubmit);
    await fillValidLeaveForm(form.container);

    await act(async () => {
      requireForm(form.container).requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = form.container.querySelector<HTMLElement>('[role="alert"]');
    expect(error?.textContent).toContain('Terjadi kendala pada layanan. Silakan coba lagi nanti.');
    expect(error?.textContent).not.toContain(serverDetail);
    expect(form.container.textContent).not.toContain(serverDetail);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(requireSubmitButton(form.container).disabled).toBe(false);
    expect(
      requireField<HTMLInputElement>(form.container, '#employee-request-start-date').value,
    ).toBe('2026-10-12');
    expect(requireField<HTMLInputElement>(form.container, '#employee-request-end-date').value).toBe(
      '2026-10-13',
    );
    expect(requireField<HTMLTextAreaElement>(form.container, 'textarea').value).toBe(
      'Keperluan keluarga',
    );
  });
});
