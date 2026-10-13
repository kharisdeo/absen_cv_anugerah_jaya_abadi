import { lazy, Suspense } from 'react';

import type { UserRole } from '../auth/session.js';
import { LoadingState } from '../components/ui/AsyncState.js';

const AdminAccountsPage = lazy(() =>
  import('../pages/AdminAccountsPage.js').then(({ AdminAccountsPage: Page }) => ({
    default: Page,
  })),
);
const AdminDashboardPage = lazy(() =>
  import('../pages/AdminDashboardPage.js').then(({ AdminDashboardPage: Page }) => ({
    default: Page,
  })),
);
const AdminEmployeesPage = lazy(() =>
  import('../pages/AdminEmployeesPage.js').then(({ AdminEmployeesPage: Page }) => ({
    default: Page,
  })),
);
const AdminShiftsPage = lazy(() =>
  import('../pages/AdminShiftsPage.js').then(({ AdminShiftsPage: Page }) => ({ default: Page })),
);
const AdminStoresPage = lazy(() =>
  import('../pages/AdminStoresPage.js').then(({ AdminStoresPage: Page }) => ({ default: Page })),
);
const EmployeeHistoryPage = lazy(() =>
  import('../pages/EmployeeHistoryPage.js').then(({ EmployeeHistoryPage: Page }) => ({
    default: Page,
  })),
);
const EmployeeLeavePage = lazy(() =>
  import('../pages/EmployeeLeavePage.js').then(({ EmployeeLeavePage: Page }) => ({
    default: Page,
  })),
);
const EmployeeRequestsPage = lazy(() =>
  import('../pages/EmployeeRequestsPage.js').then(({ EmployeeRequestsPage: Page }) => ({
    default: Page,
  })),
);
const EmployeeSchedulePage = lazy(() =>
  import('../pages/EmployeeSchedulePage.js').then(({ EmployeeSchedulePage: Page }) => ({
    default: Page,
  })),
);
const RequestReviewPage = lazy(() =>
  import('../pages/RequestReviewPage.js').then(({ RequestReviewPage: Page }) => ({
    default: Page,
  })),
);
const RoleHome = lazy(() =>
  import('../pages/RoleHome.js').then(({ RoleHome: Page }) => ({ default: Page })),
);
const VerificationReviewPage = lazy(() =>
  import('../pages/VerificationReviewPage.js').then(({ VerificationReviewPage: Page }) => ({
    default: Page,
  })),
);

const NotificationsPage = lazy(() =>
  import('../pages/NotificationsPage.js').then(({ NotificationsPage: Page }) => ({
    default: Page,
  })),
);
const AdminSystemDisruptionsPage = lazy(() =>
  import('../pages/AdminSystemDisruptionsPage.js').then(({ AdminSystemDisruptionsPage: Page }) => ({
    default: Page,
  })),
);
const AdminAuditLogsPage = lazy(() =>
  import('../pages/AdminAuditLogsPage.js').then(({ AdminAuditLogsPage: Page }) => ({
    default: Page,
  })),
);
const MonthlyReportPage = lazy(() =>
  import('../pages/MonthlyReportPage.js').then(({ MonthlyReportPage: Page }) => ({
    default: Page,
  })),
);

function pageForRoute(role: UserRole, route: string) {
  if (role === 'ADMIN' && route === '/admin') return <AdminDashboardPage />;
  if (
    (role === 'EMPLOYEE' && route === '/employee/notifications') ||
    (role === 'SUPERVISOR' && route === '/supervisor/notifications') ||
    (role === 'ADMIN' && route === '/admin/notifications')
  ) {
    return <NotificationsPage />;
  }
  if (role === 'ADMIN' && route === '/admin/system-disruptions')
    return <AdminSystemDisruptionsPage />;
  if (role === 'ADMIN' && route === '/admin/audit-logs') return <AdminAuditLogsPage />;
  if (role === 'ADMIN' && route === '/admin/reports') return <MonthlyReportPage role="ADMIN" />;
  if (role === 'SUPERVISOR' && route === '/supervisor/reports') {
    return <MonthlyReportPage role="SUPERVISOR" />;
  }
  if (role === 'EMPLOYEE' && route === '/employee/history') return <EmployeeHistoryPage />;
  if (role === 'EMPLOYEE' && route === '/employee/schedule') return <EmployeeSchedulePage />;
  if (role === 'EMPLOYEE' && route === '/employee/leave') return <EmployeeLeavePage />;
  if (role === 'EMPLOYEE' && route === '/employee/requests') return <EmployeeRequestsPage />;
  if (role === 'SUPERVISOR' && route === '/supervisor/verification') {
    return <VerificationReviewPage role="SUPERVISOR" />;
  }
  if (role === 'ADMIN' && route === '/admin/verification') {
    return <VerificationReviewPage role="ADMIN" />;
  }
  if (role === 'SUPERVISOR' && route === '/supervisor/requests') {
    return <RequestReviewPage role="SUPERVISOR" />;
  }
  if (role === 'ADMIN' && route === '/admin/requests') {
    return <RequestReviewPage role="ADMIN" />;
  }
  if (role === 'ADMIN' && route === '/admin/stores') return <AdminStoresPage />;
  if (role === 'ADMIN' && route === '/admin/employees') return <AdminEmployeesPage />;
  if (role === 'ADMIN' && route === '/admin/accounts') return <AdminAccountsPage />;
  if (role === 'ADMIN' && route === '/admin/schedules') return <AdminShiftsPage />;
  return <RoleHome role={role} />;
}

export function RolePage({ role, route }: Readonly<{ role: UserRole; route: string }>) {
  return (
    <Suspense fallback={<LoadingState label="Memuat halaman…" />}>
      {pageForRoute(role, route)}
    </Suspense>
  );
}
