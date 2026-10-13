import { DeviceBindingStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';

export type AttendanceAttemptActor = Readonly<{
  userAccountId: string;
  role: UserRole;
  employeeId: string;
  deviceBindingId: string;
}>;

export function assertAttendanceEmployeeActor(principal: AuthPrincipal): AttendanceAttemptActor {
  if (principal.role !== UserRole.EMPLOYEE) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya karyawan yang dapat mengirim percobaan absensi.');
  }

  if (
    !principal.employeeId ||
    !principal.deviceBindingId ||
    principal.deviceBindingStatus !== DeviceBindingStatus.APPROVED
  ) {
    throw new AppError(
      403,
      'ATTENDANCE_DEVICE_BINDING_REQUIRED',
      'Profil karyawan dan perangkat terdaftar yang disetujui diperlukan untuk mengirim percobaan absensi.',
    );
  }

  return {
    userAccountId: principal.userAccountId,
    role: principal.role,
    employeeId: principal.employeeId,
    deviceBindingId: principal.deviceBindingId,
  };
}
