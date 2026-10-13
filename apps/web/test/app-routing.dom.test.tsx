// @vitest-environment happy-dom

import type { ReactNode } from 'react';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../src/auth/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/session.js')>();
  return {
    ...actual,
    SessionProvider: ({ children }: Readonly<{ children: ReactNode }>) => children,
    useSession: useSessionMock,
  };
});
vi.mock('../src/components/PwaControls.js', () => ({ PwaControls: () => null }));

import { App } from '../src/app/App.js';
import { ROLE_NAVIGATION } from '../src/app/role-navigation.js';
import { homePathForRole } from '../src/auth/route-policy.js';
import type { AuthUser, UserRole } from '../src/auth/session.js';

type MountedApp = Readonly<{ container: HTMLDivElement; root: Root }>;

const roles: readonly UserRole[] = ['ADMIN', 'SUPERVISOR', 'EMPLOYEE'];
const routeCases = roles.flatMap((role) =>
  ROLE_NAVIGATION[role].map(({ to }) => ({ path: to, role })),
);

function authUser(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000801',
    username: `pengguna-${role.toLowerCase()}`,
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000802',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

async function mountApp(path: string, role: UserRole): Promise<MountedApp> {
  window.history.replaceState({}, '', path);
  useSessionMock.mockReturnValue({
    session: { status: 'authenticated', user: authUser(role) },
    refreshSession: vi.fn(async () => ({ status: 'authenticated', user: authUser(role) })),
  });

  const container = document.createElement('div');
  document.body.append(container);
  const mounted = { root: createRoot(container), container };
  await act(async () => {
    mounted.root.render(<App />);
  });
  return mounted;
}

async function unmountApp({ container, root }: MountedApp): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mounted App route table', () => {
  it('resolves every registered menu destination by direct URL for its assigned role', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    for (const { path, role } of routeCases) {
      const mounted = await mountApp(path, role);
      try {
        expect(window.location.pathname, `${role} -> ${path}`).toBe(path);
        expect(mounted.container.querySelector(`a[href="${path}"]`), `${role} -> ${path}`).not.toBe(
          null,
        );
        expect(mounted.container.textContent, `${role} -> ${path}`).not.toContain(
          'Halaman tidak ditemukan',
        );
      } finally {
        await unmountApp(mounted);
      }
    }
  }, 15_000);

  it('redirects every cross-role direct URL to access denied before showing role navigation', async () => {
    for (const { path, role: routeRole } of routeCases) {
      for (const actualRole of roles.filter((role) => role !== routeRole)) {
        const mounted = await mountApp(path, actualRole);
        try {
          expect(window.location.pathname, `${actualRole} -> ${path}`).toBe('/access-denied');
          expect(mounted.container.textContent, `${actualRole} -> ${path}`).toContain(
            'bukan untuk peran Anda.',
          );
          expect(mounted.container.querySelector(`a[href="${path}"]`)).toBeNull();
        } finally {
          await unmountApp(mounted);
        }
      }
    }
  });

  it.each(roles)('redirects / to the canonical %s landing route', async (role) => {
    const mounted = await mountApp('/', role);
    try {
      const landingPath = homePathForRole(role);
      expect(window.location.pathname).toBe(landingPath);
      expect(mounted.container.querySelector(`a[href="${landingPath}"]`)).not.toBeNull();
      expect(mounted.container.textContent).not.toContain('Halaman tidak ditemukan');
    } finally {
      await unmountApp(mounted);
    }
  });
});
