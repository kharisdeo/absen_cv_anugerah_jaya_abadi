// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/PwaControls.js', () => ({ PwaControls: () => null }));

import { App } from '../src/app/App.js';
import type { AuthUser, UserRole } from '../src/auth/session.js';

type MountedApp = Readonly<{ root: Root; container: HTMLDivElement }>;
type CapturedRequest = Readonly<{
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
}>;
type InitialServerState =
  'unauthenticated' | 'unavailable' | 'consent' | 'password' | 'device-pending';

const mountedApps: MountedApp[] = [];
const role: UserRole = 'ADMIN';
const userId = '00000000-0000-4000-8000-000000000901';
const username = 'admin-uji';
const loginPassword = 'Temporary-login-password-123';
const currentPassword = 'Temporary-first-password-123';
const newPassword = 'New-password-for-test-456';
const policy = {
  version: 'privacy-v2030-04',
  text: 'Teks kebijakan resmi dari server.\n\nKebijakan ini berlaku untuk absensi.',
  purposes: [
    { id: 'selfie', label: 'Selfie digunakan sebagai bukti absensi.' },
    { id: 'location', label: 'Lokasi hanya diambil ketika absensi dikirim.' },
  ],
} as const;

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

afterAll(() => {
  if (originalActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) {
    await act(async () => {
      app.root.unmount();
    });
    app.container.remove();
  }
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function makeUser(
  consentRequired: boolean,
  mustChangePassword: boolean,
  userRole: UserRole = role,
  deviceBindingStatus: AuthUser['deviceBindingStatus'] = null,
): AuthUser {
  return {
    id: userId,
    username,
    role: userRole,
    employeeId: userRole === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000902',
    deviceBindingStatus: userRole === 'ADMIN' ? null : deviceBindingStatus,
    consentRequired,
    mustChangePassword,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createServer(initial: InitialServerState) {
  const requests: CapturedRequest[] = [];
  let authenticated =
    initial === 'consent' || initial === 'password' || initial === 'device-pending';
  let consentAccepted = initial === 'password' || initial === 'device-pending';
  let passwordChanged = initial === 'device-pending';
  let deviceApproved = false;

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl, window.location.origin);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;

      requests.push({
        method,
        pathname: url.pathname,
        body,
        credentials: init?.credentials,
        cache: init?.cache,
      });

      if (url.pathname === '/api/v1/auth/me' && method === 'GET') {
        if (initial === 'unavailable' && !authenticated) {
          return jsonResponse({ code: 'SERVICE_UNAVAILABLE' }, 503);
        }
        if (!authenticated) return jsonResponse({ code: 'UNAUTHENTICATED' }, 401);
        const userRole = initial === 'device-pending' ? 'EMPLOYEE' : role;
        const deviceBindingStatus =
          initial === 'device-pending' ? (deviceApproved ? 'APPROVED' : 'PENDING') : null;
        return jsonResponse({
          user: makeUser(!consentAccepted, !passwordChanged, userRole, deviceBindingStatus),
        });
      }

      if (url.pathname === '/api/v1/auth/login' && method === 'POST') {
        authenticated = true;
        return jsonResponse({ ok: true });
      }

      if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
        authenticated = false;
        return new Response(null, { status: 204 });
      }

      if (url.pathname === '/api/v1/consents/current' && method === 'GET') {
        return jsonResponse({ consentRequired: !consentAccepted, policy });
      }

      if (url.pathname === '/api/v1/consents' && method === 'POST') {
        if (body?.policyVersion === policy.version && body.accepted === true) {
          consentAccepted = true;
        }
        return jsonResponse({ policyVersion: policy.version, acceptedAt: '2030-04-15T02:00:00Z' });
      }

      if (url.pathname === '/api/v1/auth/change-password' && method === 'POST') {
        passwordChanged = true;
        return jsonResponse({ changed: true });
      }

      return jsonResponse({ code: 'NOT_FOUND' }, 404);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return {
    requests,
    fetchMock,
    approveDevice: () => {
      deviceApproved = true;
    },
  };
}

async function flushUpdates(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (predicate()) return;
    await flushUpdates();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function mountApp(path: string): Promise<MountedApp> {
  window.history.replaceState({}, '', path);
  const container = document.createElement('div');
  document.body.append(container);
  const app = { root: createRoot(container), container };
  mountedApps.push(app);
  await act(async () => {
    app.root.render(<App />);
  });
  await flushUpdates();
  await flushUpdates();
  return app;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function requireInput(container: HTMLElement, selector: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Expected input: ${selector}`);
  return input;
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Expected button: ${label}`);
  return button;
}

async function clickAndFlush(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await flushUpdates();
}

function expectNoWorkArea(container: HTMLElement): void {
  expect(container.querySelector('aside[aria-label="Navigasi utama"]')).toBeNull();
  expect(container.querySelector('a[href="/admin/accounts"]')).toBeNull();
  expect(container.textContent).not.toContain('Akun pengguna');
}

function expectNoAuthSecretsInBrowserStorage(deviceToken: string): void {
  const storedValues = [window.localStorage, window.sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return key === null ? '' : (storage.getItem(key) ?? '');
      }),
    )
    .join('\n');
  expect(window.localStorage.length).toBe(1);
  expect(window.localStorage.key(0)).toBe('absen_device_token');
  expect(window.localStorage.getItem('absen_device_token')).toBe(deviceToken);
  expect(window.sessionStorage.length).toBe(0);
  expect(storedValues).not.toMatch(/password|bearer|session/i);
  expect(storedValues).not.toContain(loginPassword);
  expect(storedValues).not.toContain(currentPassword);
  expect(storedValues).not.toContain(newPassword);
}

describe('actual App first-login and onboarding flow', () => {
  it('explains the separate device approval and enters the employee workspace after rechecking', async () => {
    const server = createServer('device-pending');
    const app = await mountApp('/login');

    await waitFor(
      () => app.container.textContent?.includes('Perangkat menunggu persetujuan') === true,
      'pending device approval status',
    );
    expect(app.container.textContent).toContain(
      'Persetujuan privasi berbeda dari persetujuan perangkat',
    );
    expect(app.container.textContent).toContain('Akun pengguna');
    expect(app.container.textContent).toContain(username);
    expect(app.container.querySelector('aside[aria-label="Navigasi utama"]')).toBeNull();
    expect(app.container.querySelector('a[href="/admin/accounts"]')).toBeNull();
    expect(server.requests.filter(({ pathname }) => pathname === '/api/v1/auth/me')).toHaveLength(
      1,
    );

    server.approveDevice();
    await clickAndFlush(requireButton(app.container, 'Periksa persetujuan'));

    await waitFor(
      () =>
        window.location.pathname === '/employee' &&
        app.container.querySelector('aside[aria-label="Navigasi utama"]') !== null,
      'employee workspace after device approval is refreshed',
    );
    expect(server.requests.filter(({ pathname }) => pathname === '/api/v1/auth/me')).toHaveLength(
      2,
    );
    expect(
      server.requests.filter(({ pathname }) => pathname.startsWith('/api/v1/admin/')),
    ).toHaveLength(0);
  });

  it('logs out of a pending employee session to let the user switch to Admin', async () => {
    const server = createServer('device-pending');
    const app = await mountApp('/login');

    await waitFor(
      () => app.container.textContent?.includes('Perangkat menunggu persetujuan') === true,
      'pending device approval status',
    );
    await clickAndFlush(requireButton(app.container, 'Keluar untuk ganti akun'));

    await waitFor(
      () => app.container.textContent?.includes('Selamat datang') === true,
      'login page after logout',
    );
    expect(
      server.requests.some(
        ({ method, pathname }) => method === 'POST' && pathname === '/api/v1/auth/logout',
      ),
    ).toBe(true);
    expectNoWorkArea(app.container);
  });

  it('requires server policy consent, changes the initial password, then lands on the refreshed session role', async () => {
    const server = createServer('unauthenticated');
    window.history.replaceState({}, '', '/employee/history');
    const app = await mountApp('/employee/history');

    await waitFor(
      () =>
        window.location.pathname === '/login' &&
        app.container.textContent?.includes('Selamat datang') === true,
      'unauthenticated redirect to login',
    );
    expectNoWorkArea(app.container);

    const identifier = requireInput(app.container, 'input[name="identifier"]');
    const loginPasswordField = requireInput(app.container, 'input[name="password"]');
    await act(async () => {
      setInputValue(identifier, username);
      setInputValue(loginPasswordField, loginPassword);
    });
    await clickAndFlush(requireButton(app.container, 'Masuk'));

    await waitFor(
      () => app.container.textContent?.includes(policy.text) === true,
      'server policy on the consent onboarding screen',
    );
    expect(window.location.pathname).toBe('/login');
    expect(app.container.textContent).toContain(policy.version);
    expect(app.container.textContent).toContain(policy.purposes[0].label);
    expect(app.container.textContent).toContain(policy.purposes[1].label);
    expectNoWorkArea(app.container);

    const consentButton = requireButton(app.container, 'Setujui dan lanjutkan');
    expect(consentButton.disabled).toBe(true);
    await clickAndFlush(consentButton);
    expect(
      server.requests.filter(
        ({ method, pathname }) => method === 'POST' && pathname === '/api/v1/consents',
      ),
    ).toHaveLength(0);

    const consentCheckbox = requireInput(app.container, 'input[type="checkbox"]');
    await act(async () => {
      consentCheckbox.click();
    });
    expect(consentButton.disabled).toBe(false);
    await clickAndFlush(consentButton);

    await waitFor(
      () => app.container.textContent?.includes('Buat password baru') === true,
      'first-password onboarding after the consent session refresh',
    );
    expect(window.location.pathname).toBe('/login');
    expectNoWorkArea(app.container);

    const currentPasswordField = requireInput(app.container, 'input[name="currentPassword"]');
    const newPasswordField = requireInput(app.container, 'input[name="newPassword"]');
    const confirmationField = requireInput(app.container, 'input[name="confirmPassword"]');
    await act(async () => {
      setInputValue(currentPasswordField, currentPassword);
      setInputValue(newPasswordField, newPassword);
      setInputValue(confirmationField, newPassword);
    });
    await clickAndFlush(requireButton(app.container, 'Simpan password baru'));
    await waitFor(
      () =>
        window.location.pathname === '/admin' &&
        app.container.querySelector('aside[aria-label="Navigasi utama"]') !== null,
      'Admin landing route from the refreshed post-onboarding session',
    );
    expect(app.container.querySelector('nav.nav-list a[href="/admin"]')?.textContent).toContain(
      'Ringkasan',
    );
    expect(app.container.querySelector('a[href="/employee/history"]')).toBeNull();
    expect(server.requests.filter(({ pathname }) => pathname === '/api/v1/auth/me').length).toBe(4);
    const loginBody = server.requests.find(
      ({ pathname }) => pathname === '/api/v1/auth/login',
    )?.body;
    expect(loginBody).toMatchObject({ identifier: username, password: loginPassword });
    const deviceToken = loginBody?.deviceToken;
    expect(deviceToken).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/));
    if (typeof deviceToken !== 'string') throw new Error('Expected a valid login device token');
    const deviceName = loginBody?.deviceName;
    expect(typeof deviceName).toBe('string');
    if (typeof deviceName !== 'string') throw new Error('Expected a valid login device name');
    expect(deviceName.trim().length).toBeGreaterThan(0);
    expect(deviceName.length).toBeLessThanOrEqual(100);
    expect(
      server.requests.find(
        ({ method, pathname }) => method === 'POST' && pathname === '/api/v1/consents',
      )?.body,
    ).toEqual({ policyVersion: policy.version, accepted: true });
    expect(
      server.requests.find(({ pathname }) => pathname === '/api/v1/auth/change-password')?.body,
    ).toEqual({ currentPassword, newPassword });
    expect(
      server.requests
        .filter(
          ({ pathname }) => pathname.startsWith('/api/v1/auth/') || pathname.includes('/consent'),
        )
        .every(({ credentials, cache }) => credentials === 'include' && cache === 'no-store'),
    ).toBe(true);

    expect(loginPasswordField.value).toBe('');
    expect(currentPasswordField.value).toBe('');
    expect(newPasswordField.value).toBe('');
    expect(confirmationField.value).toBe('');
    expect(app.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expectNoAuthSecretsInBrowserStorage(deviceToken);
  });

  it('keeps direct protected routes closed when session verification is unavailable', async () => {
    const server = createServer('unavailable');
    const app = await mountApp('/admin/accounts');

    await waitFor(
      () => app.container.textContent?.includes('Layanan belum terjangkau') === true,
      'unavailable session status',
    );
    expect(window.location.pathname).toBe('/admin/accounts');
    expect(app.container.textContent).toContain(
      'Halaman kerja tetap terkunci sampai server dapat dihubungi.',
    );
    expectNoWorkArea(app.container);
    expect(server.requests.filter(({ pathname }) => pathname !== '/api/v1/auth/me')).toHaveLength(
      0,
    );
  });

  it.each([
    {
      state: 'consent' as const,
      expectedHeading: 'Tinjau kebijakan privasi',
    },
    {
      state: 'password' as const,
      expectedHeading: 'Buat password baru',
    },
  ])(
    'keeps a direct Admin work URL closed for an authenticated $state onboarding session',
    async ({ state, expectedHeading }) => {
      const server = createServer(state);
      const app = await mountApp('/admin/accounts');

      await waitFor(
        () =>
          window.location.pathname === '/login' &&
          app.container.textContent?.includes(expectedHeading) === true,
        `${state} onboarding route`,
      );
      expectNoWorkArea(app.container);
      expect(
        server.requests.filter(({ pathname }) => pathname === '/api/v1/admin/accounts').length,
      ).toBe(0);
    },
  );
});
