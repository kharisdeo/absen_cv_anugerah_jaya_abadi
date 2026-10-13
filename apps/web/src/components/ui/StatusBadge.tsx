import {
  getAttendanceValidationPresentation,
  getDailyAttendancePresentation,
  getRequestPresentation,
  type AttendanceValidationStatus,
  type DailyAttendanceStatus,
  type RequestStatus,
  type StatusPresentation,
} from '../../domain/attendance-state.js';

type StatusBadgeProps =
  | Readonly<{ domain: 'validation'; status: AttendanceValidationStatus }>
  | Readonly<{ domain: 'daily'; status: DailyAttendanceStatus }>
  | Readonly<{ domain: 'request'; status: RequestStatus }>;

function presentationForStatus(props: StatusBadgeProps): StatusPresentation {
  switch (props.domain) {
    case 'validation':
      return getAttendanceValidationPresentation(props.status);
    case 'daily':
      return getDailyAttendancePresentation(props.status);
    case 'request':
      return getRequestPresentation(props.status);
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const presentation = presentationForStatus(props);
  return (
    <span className={`ds-status ds-status--${presentation.tone}`}>
      <span className="ds-status__dot" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}
