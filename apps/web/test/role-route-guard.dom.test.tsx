// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../src/auth/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/session.js')>();
  return { ...actual, useSession: useSessionMock };
});
vi.mock('../src/components/PwaControls.js', () => ({ PwaControls: () => null }));

import { RequireRole } from '../src/app/App.js';
import { ROLE_NAVIGATION } from '../src/app/role-navigation.js';
import { AccessDeniedPage } from '../src/pages/StatusPages.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';

type RoleRouteCase = Readonly<{ role: UserRole; path: string; marker: string }>;
type MountedHarness = Readonly<{ root: Root; container: HTMLDivElement }>;

const roles: readonly UserRole[] = ['ADMIN', 'SUPERVISOR', 'EMPLOYEE'];
const roleRoutes: readonly RoleRouteCase[] = [
  { role: 'EMPLOYEE', path: '/employee/history', marker: 'employee-history' },
  { role: 'SUPERVISOR', path: '/supervisor/verification', marker: 'supervisor-verification' },
  { role: 'ADMIN', path: '/admin/employees', marker: 'admin-employees' },
];

const mountedHarnesses: MountedHarness[] = [];
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
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  for (const harness of mountedHarnesses.splice(0)) {
    await act(async () => {
      harness.root.unmount();
    });
    harness.container.remove();
  }
  vi.unstubAllGlobals();
});

function routePath(role: UserRole, path: string): string {
  const route = ROLE_NAVIGATION[role].find((item) => item.to === path);
  if (!route) throw new Error(`Expected ${path} to be registered for ${role}`);
  return route.to;
}

const registeredRoleRoutes: readonly RoleRouteCase[] = roleRoutes.map((route) => ({
  ...route,
  path: routePath(route.role, route.path),
}));

function authUser(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000701',
    username: `pengguna-${role.toLowerCase()}`,
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000702',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function setSession(session: SessionState) {
  useSessionMock.mockReturnValue({
    session,
    refreshSession: vi.fn(async () => session),
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-path">{location.pathname}</output>;
}

function RouteMarker({ route }: Readonly<{ route: RoleRouteCase }>) {
  return (
    <div data-path={route.path} data-testid={`protected-${route.marker}`}>
      Protected page for {route.role}
    </div>
  );
}

function harness(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/access-denied" element={<AccessDeniedPage />} />
        <Route element={<RequireRole />}>
          {registeredRoleRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={<RouteMarker route={route} />} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

async function mountHarness(path: string): Promise<MountedHarness> {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = { root: createRoot(container), container };
  mountedHarnesses.push(mounted);
  await act(async () => {
    mounted.root.render(harness(path));
  });
  return mounted;
}

function expectLocation(container: HTMLElement, path: string) {
  expect(container.querySelector('[data-testid="location-path"]')?.textContent).toBe(path);
}

describe('mounted RequireRole direct-route guard', () => {
  it.each(registeredRoleRoutes)(
    'renders the registered $role page marker for its authenticated role',
    async (route) => {
      setSession({ status: 'authenticated', user: authUser(route.role) });
      const mounted = await mountHarness(route.path);

      expect(
        mounted.container.querySelector(`[data-testid="protected-${route.marker}"]`),
      ).not.toBeNull();
      expect(mounted.container.textContent).toContain(`Protected page for ${route.role}`);
      expectLocation(mounted.container, route.path);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(
    registeredRoleRoutes.flatMap((route) =>
      roles.filter((role) => role !== route.role).map((actualRole) => ({ ...route, actualRole })),
    ),
  )(
    'replaces a cross-role direct URL for $actualRole with the access-denied route ($path)',
    async ({ marker, path, actualRole }) => {
      setSession({ status: 'authenticated', user: authUser(actualRole) });
      const mounted = await mountHarness(path);

      expect(mounted.container.querySelector(`[data-testid="protected-${marker}"]`)).toBeNull();
      expect(mounted.container.textContent).not.toContain('Memeriksa sesi dengan aman');
      expect(mounted.container.textContent).not.toContain('Memuat halaman');
      expect(mounted.container.textContent).toContain('bukan untuk peran Anda.');
      expectLocation(mounted.container, '/access-denied');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps a registered direct URL on the loading state until session resolution', async () => {
    setSession({ status: 'loading' });
    const route = registeredRoleRoutes.find((item) => item.role === 'ADMIN');
    if (!route) throw new Error('Expected a registered Admin route');

    const mounted = await mountHarness(route.path);

    expect(mounted.container.textContent).toContain('Memeriksa sesi dengan aman');
    expect(mounted.container.querySelector(`[data-testid="protected-${route.marker}"]`)).toBeNull();
    expectLocation(mounted.container, route.path);
    expect(fetch).not.toHaveBeenCalled();
  });
});
