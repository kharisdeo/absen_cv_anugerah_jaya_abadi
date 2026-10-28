import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import {
  decideDirectRouteAccess,
  decideRouteAccess,
  getOnboardingStep,
  homePathForRole,
} from '../auth/route-policy.js';
import { SessionProvider, USER_ROLES, useSession, type AuthUser } from '../auth/session.js';
import { AppShell } from '../components/AppShell.js';
import { PwaControls } from '../components/PwaControls.js';
import { ConsentOnboardingStep, LoginPage, PasswordOnboardingStep } from '../pages/LoginPage.js';
import { AccessDeniedPage, DevicePendingPage, SessionStatusPage } from '../pages/StatusPages.js';
import { RolePage } from './RolePage.js';
import { ROLE_BASE_PATHS, ROLE_NAVIGATION } from './role-navigation.js';

function LoadingPage() {
  return (
    <main className="public-page">
      <div className="loading-card" role="status" aria-live="polite">
        <span className="loading-mark" aria-hidden="true">
          AJ
        </span>
        <span>Memeriksa sesi dengan aman…</span>
      </div>
    </main>
  );
}

function SignedInStatus({ user, decision }: Readonly<{ user: AuthUser; decision: string }>) {
  if (decision === 'onboarding') {
    return (
      <SessionStatusPage
        title="Selesaikan pengaturan akun"
        message={
          user.consentRequired
            ? 'Persetujuan privasi diperlukan sebelum fitur absensi dapat digunakan.'
            : 'Ganti password awal sebelum melanjutkan ke ruang kerja.'
        }
      />
    );
  }
  if (decision === 'device-pending') {
    return <DevicePendingPage />;
  }
  return (
    <SessionStatusPage
      title="Sesi belum dapat diverifikasi"
      message="Hubungkan perangkat ke jaringan, lalu coba periksa kembali."
      action="reload"
    />
  );
}

function RootRoute() {
  const { session } = useSession();
  if (session.status === 'loading') return <LoadingPage />;
  if (session.status === 'unauthenticated') {
    return (
      <Navigate
        replace
        to="/login"
        state={{ notice: 'Sesi belum aktif atau telah berakhir. Masuk untuk melanjutkan.' }}
      />
    );
  }
  if (session.status === 'unavailable') {
    return (
      <SessionStatusPage
        title="Layanan belum terjangkau"
        message="Periksa koneksi Anda. Aplikasi tidak membuka halaman kerja tanpa memverifikasi sesi ke server."
        action="reload"
      />
    );
  }
  const decision = decideRouteAccess(session, session.user.role);
  if (decision === 'onboarding') return <Navigate replace to="/login" />;
  if (decision !== 'allow') return <SignedInStatus user={session.user} decision={decision} />;
  return <Navigate replace to={homePathForRole(session.user.role)} />;
}

function LoginRoute() {
  const { session } = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <LoadingPage />;
  if (session.status === 'unauthenticated') {
    const notice =
      typeof location.state === 'object' &&
      location.state !== null &&
      'notice' in location.state &&
      typeof location.state.notice === 'string'
        ? location.state.notice
        : undefined;
    return <LoginPage initialError={notice} />;
  }
  if (session.status === 'unavailable') {
    return (
      <SessionStatusPage
        title="Layanan belum terjangkau"
        message="Hubungkan aplikasi ke server untuk memeriksa status sesi."
        action="reload"
      />
    );
  }
  const step = getOnboardingStep(session.user);
  if (step === 'consent') return <ConsentOnboardingStep />;
  if (step === 'password') return <PasswordOnboardingStep />;
  if (step === 'device-pending') {
    return <SignedInStatus user={session.user} decision="device-pending" />;
  }
  return <Navigate replace to={homePathForRole(session.user.role)} />;
}

export function RequireRole() {
  const { session } = useSession();
  const location = useLocation();
  const decision = decideDirectRouteAccess(session, location.pathname);
  if (decision === 'loading') return <LoadingPage />;
  if (decision === 'login') {
    return (
      <Navigate
        replace
        to="/login"
        state={{ notice: 'Sesi belum aktif atau telah berakhir. Masuk untuk melanjutkan.' }}
      />
    );
  }
  if (decision === 'unavailable') {
    return (
      <SessionStatusPage
        title="Layanan belum terjangkau"
        message="Sesi tidak dapat diverifikasi. Halaman kerja tetap terkunci sampai server dapat dihubungi."
        action="reload"
      />
    );
  }
  if (decision === 'onboarding' || decision === 'device-pending') {
    if (session.status !== 'authenticated') return <LoadingPage />;
    if (decision === 'onboarding') return <Navigate replace to="/login" />;
    return <SignedInStatus user={session.user} decision={decision} />;
  }
  if (decision === 'not-found') return <Navigate replace to="/access-denied" />;
  if (decision === 'wrong-role') return <Navigate replace to="/access-denied" />;
  return <Outlet />;
}

function RoleLayout() {
  const { session } = useSession();
  if (session.status !== 'authenticated') return <LoadingPage />;
  return <AppShell user={session.user} />;
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <PwaControls />
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/access-denied" element={<AccessDeniedPage />} />
          {USER_ROLES.map((role) => {
            const basePath = ROLE_BASE_PATHS[role];
            return (
              <Route key={role} element={<RequireRole />}>
                <Route path={basePath} element={<RoleLayout />}>
                  {ROLE_NAVIGATION[role].map((item) => {
                    if (item.to === basePath) {
                      return (
                        <Route
                          key={item.to}
                          index
                          element={<RolePage role={role} route={item.to} />}
                        />
                      );
                    }

                    return (
                      <Route
                        key={item.to}
                        path={item.to.slice(basePath.length + 1)}
                        element={<RolePage role={role} route={item.to} />}
                      />
                    );
                  })}
                </Route>
              </Route>
            );
          })}
          <Route
            path="*"
            element={
              <SessionStatusPage
                title="Halaman tidak ditemukan"
                message="Alamat yang Anda buka belum tersedia."
              />
            }
          />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
