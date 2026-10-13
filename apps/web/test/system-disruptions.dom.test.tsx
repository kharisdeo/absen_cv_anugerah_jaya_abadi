// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemDisruptionPage } from '../src/api/system-disruptions-api.js';
import { AdminSystemDisruptionsPage } from '../src/pages/AdminSystemDisruptionsPage.js';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  listStores: vi.fn(),
}));

vi.mock('../src/api/system-disruptions-api.js', () => ({
  systemDisruptionsApi: { list: api.list, create: api.create },
}));

vi.mock('../src/api/admin-stores-api.js', () => ({
  adminStoresApi: { listStores: api.listStores },
}));

type MountedPage = Readonly<{ root: Root; container: HTMLDivElement }>;

const emptyPage: SystemDisruptionPage = {
  items: [],
  page: 1,
  pageSize: 25,
  hasNextPage: false,
};

const mountedPages: MountedPage[] = [];
const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(dialogPrototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(dialogPrototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

afterAll(() => {
  if (originalShowModal) {
    Object.defineProperty(dialogPrototype, 'showModal', originalShowModal);
  } else {
    Reflect.deleteProperty(dialogPrototype, 'showModal');
  }
  if (originalClose) {
    Object.defineProperty(dialogPrototype, 'close', originalClose);
  } else {
    Reflect.deleteProperty(dialogPrototype, 'close');
  }
  if (originalActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

beforeEach(() => {
  api.list.mockReset().mockResolvedValue(emptyPage);
  api.create.mockReset();
  api.listStores.mockReset().mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  for (const page of mountedPages.splice(0)) {
    await act(async () => {
      page.root.unmount();
    });
    page.container.remove();
  }
  vi.unstubAllGlobals();
});

async function mountPage(): Promise<MountedPage> {
  const container = document.createElement('div');
  document.body.append(container);
  const page = { root: createRoot(container), container };
  mountedPages.push(page);
  await act(async () => {
    page.root.render(<AdminSystemDisruptionsPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushUpdates();
  return page;
}

async function flushUpdates() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

function findHeading(container: HTMLElement, label: string): HTMLHeadingElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLHeadingElement>('h1, h2, h3')).find(
      (heading) => heading.textContent?.trim() === label,
    ) ?? null
  );
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clickAndFlush(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushUpdates();
}

describe('mounted Admin system-disruption page', () => {
  it('keeps the regular no-data state unchanged without an ambiguous submission', async () => {
    const page = await mountPage();

    expect(findHeading(page.container, 'Belum ada gangguan tercatat')).not.toBeNull();
    expect(page.container.textContent).toContain(
      'Pencatatan baru akan muncul di sini setelah disimpan oleh Admin.',
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not imply an ambiguous POST was absent when review returns an empty page', async () => {
    const networkError = Object.assign(new Error('network unavailable'), {
      status: 0,
      code: 'NETWORK_ERROR',
    });
    api.create.mockRejectedValueOnce(networkError);
    const page = await mountPage();

    expect(findHeading(page.container, 'Belum ada gangguan tercatat')).not.toBeNull();
    expect(api.create).not.toHaveBeenCalled();

    const dateInputs = page.container.querySelectorAll<HTMLInputElement>(
      'input[type="datetime-local"]',
    );
    const reason = page.container.querySelector<HTMLTextAreaElement>('textarea');
    expect(dateInputs).toHaveLength(2);
    expect(reason).not.toBeNull();

    await act(async () => {
      setInputValue(dateInputs[0]!, '2026-10-11T09:00');
      setInputValue(dateInputs[1]!, '2026-10-11T11:00');
      setInputValue(reason!, 'Pemeliharaan jaringan');
    });

    await clickAndFlush(requireButton(page.container, 'Tinjau pencatatan'));
    expect(api.create).not.toHaveBeenCalled();
    expect(findHeading(page.container, 'Konfirmasi gangguan sistem')).not.toBeNull();
    expect(page.container.querySelector('dialog')?.hasAttribute('open')).toBe(true);

    await clickAndFlush(requireButton(page.container, 'Konfirmasi dan simpan'));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({
      storeId: null,
      startsAt: '2026-10-11T09:00:00+07:00',
      endsAt: '2026-10-11T11:00:00+07:00',
      reason: 'Pemeliharaan jaringan',
    });
    expect(page.container.textContent).toContain('Hasil POST ambigu — pengiriman dikunci');
    expect(page.container.textContent).toContain('tidak membuktikan record tidak tersimpan');

    await clickAndFlush(requireButton(page.container, 'Muat ulang daftar · halaman 1'));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 }, expect.any(AbortSignal));

    const emptyState = page.container.querySelector<HTMLElement>('.ds-state--empty');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.querySelector('h2')?.textContent).toBe('Tidak ada hasil pada daftar ini');
    expect(emptyState?.textContent).toContain('Hasil yang dimuat saat ini kosong.');
    expect(emptyState?.textContent).toContain(
      'ini bukan bukti bahwa POST gagal atau gangguan tidak tersimpan.',
    );
    expect(emptyState?.textContent).toContain('Jangan kirim ulang');
    expect(findHeading(page.container, 'Belum ada gangguan tercatat')).toBeNull();

    const submit = requireButton(page.container, 'Tinjau pencatatan');
    expect(submit.disabled).toBe(true);
    expect(page.container.querySelector('fieldset')?.disabled).toBe(true);
    await clickAndFlush(submit);
    const form = page.container.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(page.container.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
