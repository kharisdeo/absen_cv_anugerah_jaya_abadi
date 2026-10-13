import type { AdminDashboard } from '../api/admin-dashboard-api.js';

export const ADMIN_DASHBOARD_POLL_INTERVAL_MS = 60_000;

export type DashboardVisibilityTarget = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

export type AdminDashboardPoller = Readonly<{
  refresh: () => void;
  stop: () => void;
}>;

export function startAdminDashboardPolling(
  load: () => Promise<AdminDashboard>,
  handlers: Readonly<{
    onStart: () => void;
    onSuccess: (dashboard: AdminDashboard) => void;
    onError: (error: unknown) => void;
  }>,
  visibilityTarget: DashboardVisibilityTarget,
  intervalMs = ADMIN_DASHBOARD_POLL_INTERVAL_MS,
): AdminDashboardPoller {
  let stopped = false;
  let inFlight = false;

  const run = async (requireVisible: boolean): Promise<void> => {
    if (stopped || inFlight || (requireVisible && visibilityTarget.visibilityState !== 'visible')) {
      return;
    }
    inFlight = true;
    handlers.onStart();
    try {
      const dashboard = await load();
      if (!stopped) handlers.onSuccess(dashboard);
    } catch (error: unknown) {
      if (!stopped) handlers.onError(error);
    } finally {
      inFlight = false;
    }
  };

  const handleVisibilityChange = () => {
    if (visibilityTarget.visibilityState === 'visible') void run(true);
  };
  const interval = setInterval(() => void run(true), intervalMs);
  visibilityTarget.addEventListener('visibilitychange', handleVisibilityChange);
  void run(false);

  return {
    refresh: () => void run(false),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      visibilityTarget.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}
