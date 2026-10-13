export type EmployeeHistoryFilterState = Readonly<{
  page: number;
  from: string;
  to: string;
}>;

export type EmployeeHistoryFilterAction =
  | Readonly<{ type: 'from'; value: string }>
  | Readonly<{ type: 'to'; value: string }>
  | Readonly<{ type: 'page'; value: number }>
  | Readonly<{ type: 'reset' }>;

export const INITIAL_EMPLOYEE_HISTORY_FILTER: EmployeeHistoryFilterState = {
  page: 1,
  from: '',
  to: '',
};

export function reduceEmployeeHistoryFilter(
  state: EmployeeHistoryFilterState,
  action: EmployeeHistoryFilterAction,
): EmployeeHistoryFilterState {
  switch (action.type) {
    case 'from':
      return { ...state, from: action.value, page: 1 };
    case 'to':
      return { ...state, to: action.value, page: 1 };
    case 'page':
      return { ...state, page: action.value };
    case 'reset':
      return INITIAL_EMPLOYEE_HISTORY_FILTER;
  }
}
