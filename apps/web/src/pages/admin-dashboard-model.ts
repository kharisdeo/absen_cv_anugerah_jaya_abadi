export type AdminDashboardFilters = Readonly<{
  date: string;
  storeId: string;
  shiftId: string;
  page: number;
}>;

export const INITIAL_ADMIN_DASHBOARD_FILTERS: AdminDashboardFilters = {
  date: '',
  storeId: '',
  shiftId: '',
  page: 1,
};

export type AdminDashboardFilterAction =
  | Readonly<{ type: 'date'; value: string }>
  | Readonly<{ type: 'store'; value: string }>
  | Readonly<{ type: 'shift'; value: string }>
  | Readonly<{ type: 'page'; value: number }>;

export function reduceAdminDashboardFilters(
  state: AdminDashboardFilters,
  action: AdminDashboardFilterAction,
): AdminDashboardFilters {
  switch (action.type) {
    case 'date':
      return action.value === state.date ? state : { ...state, date: action.value, page: 1 };
    case 'store':
      return action.value === state.storeId ? state : { ...state, storeId: action.value, page: 1 };
    case 'shift':
      return action.value === state.shiftId ? state : { ...state, shiftId: action.value, page: 1 };
    case 'page':
      return Number.isSafeInteger(action.value) && action.value > 0
        ? { ...state, page: action.value }
        : state;
  }
}
