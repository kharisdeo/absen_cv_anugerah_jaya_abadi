// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE_BASE_PATHS } from '../src/app/role-navigation.js';
import { SessionProvider, useSession, type AuthUser, type UserRole } from '../src/auth/session.js';
import { AppShell } from '../src/components/AppShell.js';

type Mounted = Readonly<{ root: Root; container: HTMLDivElement }>;

const mounted: Mounted[] = [];
const fetchMock = vi.fn<typeof fetch>();
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

const roles: readonly UserRole[] = ['ADMIN', 'SUPERVISOR', 'EMPLOYEE'];

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    username: `pengguna-${role.toLowerCase()}`,
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000902',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function sessionResponse(role: UserRole): Response {
  return new Response(JSON.stringify({ user: user(role), consentRequired: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function AppHarness({ role }: Readonly<{ role: UserRole }>) {
  const location = useLocation();
  const { session } = useSession();

  return (
    <>
      <output data-testid="current-path">{location.pathname}</output>
      <output data-testid="session-status">{session.status}</output>
      <Routes>
        <Route path={ROLE_BASE_PATHS[role]} element={<AppShell user={user(role)} />}>
          <Route index element={<p>Halaman kerja</p>} />
        </Route>
        <Route path="/login" element={<p>Halaman login</p>} />
      </Routes>
    </>
  );
}

function SessionProbe() {
  const { session, invalidateSession } = useSession();
  return (
    <>
      <output data-testid="session-status">{session.status}</output>
      <button onClick={invalidateSession}>Invalidasi sesi</button>
    </>
  );
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

beforeEach(() => vi.stubGlobal('fetch', fetchMock));

afterEach(async () => {
  for (const page of mounted.splice(0)) {
    await act(async () => page.root.unmount());
    page.container.remove();
  }
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

afterAll(() => {
  if (originalActEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

async function flushUpdates(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const page = { root: createRoot(container), container };
  mounted.push(page);
  await act(async () => page.root.render(element));
  await flushUpdates();
  return page;
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Expected button: ${label}`);
  return button;
}

function requireOutput(container: HTMLElement, testId: string): HTMLOutputElement {
  const output = container.querySelector<HTMLOutputElement>(`output[data-testid="${testId}"]`);
  if (!output) throw new Error(`Expected output: ${testId}`);
  return output;
}

describe('AppShell logout', () => {
  it.each(roles)(
    'shows logout for %s and navigates only after the API confirms success',
    async (role) => {
      fetchMock.mockImplementation(async (input) => {
        if (String(input) === '/api/v1/auth/me') return sessionResponse(role);
        if (String(input) === '/api/v1/auth/logout') return new Response(null, { status: 204 });
        return new Response(null, { status: 404 });
      });

      const page = await mount(
        <SessionProvider>
          <MemoryRouter initialEntries={[ROLE_BASE_PATHS[role]]}>
            <AppHarness role={role} />
          </MemoryRouter>
        </SessionProvider>,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requireOutput(page.container, 'session-status').textContent).toBe('authenticated');
      expect(requireButton(page.container, 'Keluar')).not.toBeNull();

      await act(async () => {
        requireButton(page.container, 'Keluar').click();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await flushUpdates();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout');
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      expect(requireOutput(page.container, 'session-status').textContent).toBe('unauthenticated');
      expect(requireOutput(page.container, 'current-path').textContent).toBe('/login');
      expect(page.container.textContent).toContain('Halaman login');
    },
  );

  it('keeps the user signed in and reports a network error when logout is not confirmed', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/v1/auth/me') return sessionResponse('EMPLOYEE');
      if (String(input) === '/api/v1/auth/logout') throw new TypeError('Network unavailable');
      return new Response(null, { status: 404 });
    });

    const page = await mount(
      <SessionProvider>
        <MemoryRouter initialEntries={[ROLE_BASE_PATHS.EMPLOYEE]}>
          <AppHarness role="EMPLOYEE" />
        </MemoryRouter>
      </SessionProvider>,
    );

    await act(async () => {
      requireButton(page.container, 'Keluar').click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await flushUpdates();

    expect(requireOutput(page.container, 'session-status').textContent).toBe('authenticated');
    expect(requireOutput(page.container, 'current-path').textContent).toBe(
      ROLE_BASE_PATHS.EMPLOYEE,
    );
    expect(page.container.textContent).toContain('Logout belum berhasil');
    expect(page.container.textContent).toContain(
      'Tidak dapat terhubung ke server atau penyimpanan. Periksa koneksi lalu coba lagi.',
    );
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('does not let an older in-flight session response restore an invalidated session', async () => {
    let resolveSession!: (response: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (resolveSession = resolve)),
    );

    const page = await mount(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    expect(requireOutput(page.container, 'session-status').textContent).toBe('loading');
    await act(async () => requireButton(page.container, 'Invalidasi sesi').click());
    expect(requireOutput(page.container, 'session-status').textContent).toBe('unauthenticated');

    await act(async () => {
      resolveSession(sessionResponse('EMPLOYEE'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(requireOutput(page.container, 'session-status').textContent).toBe('unauthenticated');
  });
});
