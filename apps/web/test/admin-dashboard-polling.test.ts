import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminDashboard } from '../src/api/admin-dashboard-api.js';
import {
  ADMIN_DASHBOARD_POLL_INTERVAL_MS,
  startAdminDashboardPolling,
  type DashboardVisibilityTarget,
} from '../src/pages/admin-dashboard-polling.js';

class TestVisibilityTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.delete(listener);
  }

  changeVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    const event = new Event('visibilitychange');
    for (const listener of this.listeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function emptyDashboard(): AdminDashboard {
  const summary = {
    scheduledShifts: 0,
    present: 0,
    late: 0,
    notCheckedIn: 0,
    absent: 0,
    leave: 0,
    sick: 0,
    annualLeave: 0,
    waitingVerification: 0,
    pendingRequests: 0,
  };
  const start = new Date('2026-09-12T00:00:00.000Z');
  const trend = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), ...summary };
  });
  return {
    summary,
    notCheckedIn: { items: [], page: 1, pageSize: 25, hasNextPage: false },
    trend,
    lateRanking: [],
  };
}

afterEach(() => vi.useRealTimers());

describe('Admin dashboard polling', () => {
  it('uses a 60-second visible-only interval and does not overlap the same query', async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibilityTarget();
    let resolveCurrent: ((value: AdminDashboard) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<AdminDashboard>((resolve) => {
          resolveCurrent = resolve;
        }),
    );
    const poller = startAdminDashboardPolling(
      load,
      { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() },
      visibility as unknown as DashboardVisibilityTarget,
    );

    expect(ADMIN_DASHBOARD_POLL_INTERVAL_MS).toBe(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_POLL_INTERVAL_MS * 2);
    expect(load).toHaveBeenCalledTimes(1);

    resolveCurrent?.(emptyDashboard());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_POLL_INTERVAL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('pauses while hidden, refreshes when visible, and removes timer/listener on cleanup', async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibilityTarget();
    const load = vi.fn().mockResolvedValue(emptyDashboard());
    const poller = startAdminDashboardPolling(
      load,
      { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() },
      visibility as unknown as DashboardVisibilityTarget,
    );
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(visibility.listenerCount).toBe(1);

    visibility.changeVisibility('hidden');
    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_POLL_INTERVAL_MS * 2);
    expect(load).toHaveBeenCalledTimes(1);

    visibility.changeVisibility('visible');
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    poller.stop();
    expect(visibility.listenerCount).toBe(0);
    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_POLL_INTERVAL_MS * 2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not publish in-flight results after cleanup', async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibilityTarget();
    let resolveCurrent: ((value: AdminDashboard) => void) | undefined;
    const onSuccess = vi.fn();
    const load = () =>
      new Promise<AdminDashboard>((resolve) => {
        resolveCurrent = resolve;
      });
    const poller = startAdminDashboardPolling(
      load,
      { onStart: vi.fn(), onSuccess, onError: vi.fn() },
      visibility as unknown as DashboardVisibilityTarget,
    );
    poller.stop();
    resolveCurrent?.(emptyDashboard());
    await Promise.resolve();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
