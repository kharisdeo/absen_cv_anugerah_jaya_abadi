import { Prisma, RequestStatus, RequestType, UserRole } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { EMPLOYEE_REQUEST_TYPES } from './index.js';
import type {
  AttendanceRequestActor,
  AttendanceRequestRecord,
  AttendanceRequestRepository,
  EmployeeRequestType,
} from './index.js';

const REQUEST_TYPES = [...EMPLOYEE_REQUEST_TYPES];
const REVIEW_CANDIDATE_LIMIT = 5_000;

const requestSelect = {
  id: true,
  employeeId: true,
  requestType: true,
  startDate: true,
  endDate: true,
  reason: true,
  attachmentObjectKey: true,
  requestedOvertimeMinutes: true,
  status: true,
  approverUserAccountId: true,
  decisionAt: true,
  decisionNote: true,
  requestedAt: true,
  employee: { select: { fullName: true, accountId: true } },
  approver: { select: { role: true } },
} as const;

const scopedRequestSelect = {
  ...requestSelect,
  employee: {
    select: {
      fullName: true,
      accountId: true,
      storeAssignments: { select: { storeId: true } },
      shiftAssignments: {
        select: {
          storeId: true,
          effectiveFrom: true,
          effectiveTo: true,
          workShift: { select: { workDays: true } },
        },
      },
    },
  },
} as const;

const employeeRequestScopeSelect = {
  storeAssignments: { select: { storeId: true } },
  shiftAssignments: {
    select: {
      storeId: true,
      effectiveFrom: true,
      effectiveTo: true,
      workShift: { select: { workDays: true } },
    },
  },
} as const;

const requestDecisionScopeSelect = {
  id: true,
  requestType: true,
  startDate: true,
  endDate: true,
  status: true,
  employee: { select: employeeRequestScopeSelect },
} as const;

type RequestRow = Prisma.AttendanceRequestGetPayload<{ select: typeof requestSelect }>;
type ScopedRequestRow = Prisma.AttendanceRequestGetPayload<{ select: typeof scopedRequestSelect }>;
type EmployeeRequestScopeRow = Prisma.EmployeeGetPayload<{
  select: typeof employeeRequestScopeSelect;
}>;
type RequestDecisionScopeRow = Prisma.AttendanceRequestGetPayload<{
  select: typeof requestDecisionScopeSelect;
}>;
type ScopeAssignment = Readonly<{
  storeId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  workShift: Readonly<{ workDays: readonly number[] }>;
}>;

function notFound(): AppError {
  return new AppError(404, 'ATTENDANCE_REQUEST_NOT_FOUND', 'Pengajuan tidak ditemukan.');
}

function overlap(): AppError {
  return new AppError(
    409,
    'ATTENDANCE_REQUEST_DATE_OVERLAP',
    'Tanggal bertumpang tindih dengan pengajuan aktif lain.',
  );
}

function decisionConflict(): AppError {
  return new AppError(
    409,
    'ATTENDANCE_REQUEST_DECISION_CONFLICT',
    'Pengajuan sudah diputuskan atau tidak lagi menunggu.',
  );
}

function mapRow(row: RequestRow): AttendanceRequestRecord | null {
  if (!(REQUEST_TYPES as readonly RequestType[]).includes(row.requestType)) return null;
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeFullName: row.employee.fullName,
    requestType: row.requestType as EmployeeRequestType,
    startDate: row.startDate,
    endDate: row.endDate,
    reason: row.reason,
    attachmentObjectKey: row.attachmentObjectKey,
    requestedOvertimeMinutes: row.requestedOvertimeMinutes,
    status: row.status,
    approverUserAccountId: row.approverUserAccountId,
    approverRole: row.approver?.role ?? null,
    decisionAt: row.decisionAt,
    decisionNote: row.decisionNote,
    requestedAt: row.requestedAt,
  };
}

function mapScopedRow(row: ScopedRequestRow): AttendanceRequestRecord | null {
  return mapRow(row as unknown as RequestRow);
}

function hasScheduledDate(assignment: ScopeAssignment, startDate: Date, endDate: Date): boolean {
  const start = new Date(Math.max(startDate.getTime(), assignment.effectiveFrom.getTime()));
  const end = new Date(
    Math.min(endDate.getTime(), assignment.effectiveTo?.getTime() ?? endDate.getTime()),
  );
  if (start > end) return false;
  const startIsoDay = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  return assignment.workShift.workDays.some((workDay) => {
    const offset = (workDay - startIsoDay + 7) % 7;
    return start.getTime() + offset * 86_400_000 <= end.getTime();
  });
}

/** Fail-closed store derivation: only one non-global store across scheduled dates is reviewable. */
export function deriveUniqueScheduledStore(
  assignments: readonly ScopeAssignment[],
  employeeStoreIds: readonly string[],
  startDate: Date,
  endDate: Date,
): string | null {
  const relevant = assignments.filter((assignment) =>
    hasScheduledDate(assignment, startDate, endDate),
  );
  if (relevant.length === 0 || relevant.some((assignment) => assignment.storeId === null))
    return null;
  const storeIds = [...new Set(relevant.map((assignment) => assignment.storeId!))];
  if (storeIds.length !== 1 || !employeeStoreIds.includes(storeIds[0]!)) return null;
  return storeIds[0]!;
}

function isSupportedRowType(type: RequestType): type is EmployeeRequestType {
  return (REQUEST_TYPES as readonly RequestType[]).includes(type);
}

function filterForActor(actor: AttendanceRequestActor): Prisma.AttendanceRequestWhereInput | null {
  if (actor.role === UserRole.ADMIN) return {};
  if (actor.role === UserRole.EMPLOYEE) {
    return actor.employeeId ? { employeeId: actor.employeeId } : null;
  }
  return null;
}

async function supervisorStoreIds(
  prisma: Pick<PrismaClient, 'supervisorStoreAssignment'>,
  userAccountId: string,
): Promise<string[]> {
  const rows = await prisma.supervisorStoreAssignment.findMany({
    where: { supervisorUserAccountId: userAccountId },
    select: { storeId: true },
  });
  return rows.map(({ storeId }) => storeId);
}

function scopedForSupervisor(row: ScopedRequestRow, allowedStoreIds: readonly string[]): boolean {
  if (allowedStoreIds.length === 0) return false;
  const schedule = row.employee.shiftAssignments;
  const employeeStores = row.employee.storeAssignments.map(({ storeId }) => storeId);
  const storeId = deriveUniqueScheduledStore(schedule, employeeStores, row.startDate, row.endDate);
  return storeId !== null && allowedStoreIds.includes(storeId);
}

function hasRelevantAssignedStore(
  row: RequestDecisionScopeRow,
  allowedStoreIds: readonly string[],
): boolean {
  return row.employee.shiftAssignments.some(
    (assignment) =>
      assignment.storeId !== null &&
      allowedStoreIds.includes(assignment.storeId) &&
      hasScheduledDate(assignment, row.startDate, row.endDate),
  );
}

function requestScopeAssignments(row: {
  shiftAssignments: readonly ScopeAssignment[];
}): readonly ScopeAssignment[] {
  return row.shiftAssignments;
}

export class PrismaAttendanceRequestRepository implements AttendanceRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Parameters<AttendanceRequestRepository['create']>[0]) {
    const employeeId = input.actor.employeeId;
    if (input.actor.role !== UserRole.EMPLOYEE || !employeeId) {
      throw new AppError(403, 'FORBIDDEN', 'Hanya karyawan yang dapat mengajukan permintaan.');
    }
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT id FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE
          `;
          const employee: EmployeeRequestScopeRow | null = await transaction.employee.findFirst({
            where: {
              id: employeeId,
              accountId: input.actor.userAccountId,
              status: 'ACTIVE',
            },
            select: {
              ...employeeRequestScopeSelect,
              shiftAssignments: {
                where: {
                  effectiveFrom: { lte: input.endDate },
                  OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.startDate } }],
                },
                select: employeeRequestScopeSelect.shiftAssignments.select,
              },
            },
          });
          if (!employee)
            throw new AppError(
              403,
              'EMPLOYEE_PROFILE_REQUIRED',
              'Profil karyawan aktif tidak tersedia.',
            );

          const storeIds = employee.storeAssignments.map(({ storeId }) => storeId);
          const relevantSchedule = requestScopeAssignments({
            shiftAssignments: employee.shiftAssignments,
          }).filter((assignment) => hasScheduledDate(assignment, input.startDate, input.endDate));
          if (
            relevantSchedule.some(
              (assignment) => assignment.storeId !== null && !storeIds.includes(assignment.storeId),
            )
          ) {
            throw new AppError(
              409,
              'REQUEST_SCHEDULE_STORE_MISMATCH',
              'Jadwal tidak sesuai dengan penugasan toko karyawan.',
            );
          }

          const conflicting = await transaction.attendanceRequest.findFirst({
            where: {
              employeeId,
              requestType: { in: REQUEST_TYPES },
              status: { in: [RequestStatus.PENDING, RequestStatus.APPROVED] },
              startDate: { lte: input.endDate },
              endDate: { gte: input.startDate },
            },
            select: { id: true },
          });
          if (conflicting) throw overlap();

          const row = await transaction.attendanceRequest.create({
            data: {
              id: input.id,
              employeeId,
              requestType: input.requestType,
              startDate: input.startDate,
              endDate: input.endDate,
              reason: input.reason,
              attachmentObjectKey: input.attachmentObjectKey,
              requestedOvertimeMinutes: input.requestedOvertimeMinutes,
            },
            select: requestSelect,
          });
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: input.actor.userAccountId,
              action: 'attendance_request.create',
              entityType: 'attendance_request',
              entityId: row.id,
              afterData: {
                requestType: row.requestType,
                startDate: row.startDate.toISOString().slice(0, 10),
                endDate: row.endDate.toISOString().slice(0, 10),
                status: row.status,
                requestedOvertimeMinutes: row.requestedOvertimeMinutes,
                hasAttachment: row.attachmentObjectKey !== null,
              },
              reason: 'Pengajuan dibuat oleh karyawan.',
              requestId: input.requestId,
            },
          });
          const administrators = await transaction.userAccount.findMany({
            where: { role: UserRole.ADMIN, status: 'ACTIVE' },
            select: { id: true },
          });
          if (administrators.length > 0) {
            await transaction.notification.createMany({
              data: administrators.map(({ id }) => ({
                userAccountId: id,
                kind: 'ATTENDANCE_REQUEST',
                title: 'Pengajuan baru perlu ditinjau',
                message: 'Ada pengajuan karyawan yang menunggu peninjauan.',
                payload: { attendanceRequestId: row.id, requestType: row.requestType },
              })),
            });
          }
          const mapped = mapRow(row as RequestRow);
          if (!mapped)
            throw new AppError(
              400,
              'UNSUPPORTED_ATTENDANCE_REQUEST',
              'Jenis pengajuan tidak didukung.',
            );
          return mapped;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw overlap();
      }
      throw error;
    }
  }

  async list(input: Parameters<AttendanceRequestRepository['list']>[0]) {
    const baseWhere: Prisma.AttendanceRequestWhereInput = {
      requestType: input.requestType ?? { in: REQUEST_TYPES },
      ...(input.status === undefined ? {} : { status: input.status }),
    };
    const actorWhere = filterForActor(input.actor);
    if (input.actor.role === UserRole.EMPLOYEE) {
      if (!actorWhere) return { items: [], hasNextPage: false };
      const rows = await this.prisma.attendanceRequest.findMany({
        where: { AND: [baseWhere, actorWhere] },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: input.skip,
        take: input.take,
        select: requestSelect,
      });
      const items = rows.flatMap((row) => {
        const mapped = mapRow(row);
        return mapped ? [mapped] : [];
      });
      return { items, hasNextPage: rows.length === input.take };
    }
    if (input.actor.role === UserRole.ADMIN) {
      const rows = await this.prisma.attendanceRequest.findMany({
        where: baseWhere,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: input.skip,
        take: input.take,
        select: requestSelect,
      });
      const items = rows.flatMap((row) => {
        const mapped = mapRow(row);
        return mapped ? [mapped] : [];
      });
      return { items, hasNextPage: rows.length === input.take };
    }

    const allowedStoreIds = await supervisorStoreIds(this.prisma, input.actor.userAccountId);
    if (allowedStoreIds.length === 0) return { items: [], hasNextPage: false };
    const rows = await this.prisma.attendanceRequest.findMany({
      where: {
        AND: [
          baseWhere,
          {
            requestType: {
              in: [
                RequestType.LEAVE,
                RequestType.SICK,
                RequestType.ANNUAL_LEAVE,
                RequestType.OVERTIME,
              ],
            },
          },
          { employee: { shiftAssignments: { some: { storeId: { in: allowedStoreIds } } } } },
        ],
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: REVIEW_CANDIDATE_LIMIT + 1,
      select: scopedRequestSelect,
    });
    if (rows.length > REVIEW_CANDIDATE_LIMIT) {
      throw new AppError(
        503,
        'REQUEST_SCOPE_REVIEW_LIMIT',
        'Daftar perlu dipersempit sebelum dapat ditinjau.',
      );
    }
    const scoped = rows.flatMap((row) => {
      if (!scopedForSupervisor(row, allowedStoreIds)) return [];
      const mapped = mapScopedRow(row);
      return mapped ? [mapped] : [];
    });
    return {
      items: scoped.slice(input.skip, input.skip + input.take),
      hasNextPage: scoped.length > input.skip + input.take,
    };
  }

  async findAccessible(input: Parameters<AttendanceRequestRepository['findAccessible']>[0]) {
    if (input.actor.role === UserRole.SUPERVISOR) {
      const allowedStoreIds = await supervisorStoreIds(this.prisma, input.actor.userAccountId);
      if (allowedStoreIds.length === 0) return null;
      const row = await this.prisma.attendanceRequest.findFirst({
        where: {
          id: input.requestId,
          requestType: {
            in: [
              RequestType.LEAVE,
              RequestType.SICK,
              RequestType.ANNUAL_LEAVE,
              RequestType.OVERTIME,
            ],
          },
          employee: { shiftAssignments: { some: { storeId: { in: allowedStoreIds } } } },
        },
        select: scopedRequestSelect,
      });
      if (!row || !scopedForSupervisor(row, allowedStoreIds)) return null;
      return mapScopedRow(row);
    }
    const actorWhere = filterForActor(input.actor);
    if (!actorWhere) return null;
    const where: Prisma.AttendanceRequestWhereInput = {
      id: input.requestId,
      requestType: { in: REQUEST_TYPES },
      ...actorWhere,
    };
    const row = await this.prisma.attendanceRequest.findFirst({ where, select: requestSelect });
    return row ? mapRow(row) : null;
  }

  async decide(input: Parameters<AttendanceRequestRepository['decide']>[0]) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const isAdmin = input.actor.role === UserRole.ADMIN;
          const allowedTypes = REQUEST_TYPES;
          let row: RequestRow | null;
          if (!isAdmin) {
            const allowedStoreIds = await supervisorStoreIds(
              transaction,
              input.actor.userAccountId,
            );

            if (allowedStoreIds.length === 0) throw notFound();
            const candidate: RequestDecisionScopeRow | null =
              await transaction.attendanceRequest.findFirst({
                where: {
                  id: input.requestId,
                  requestType: { in: allowedTypes },
                  employee: {
                    shiftAssignments: { some: { storeId: { in: allowedStoreIds } } },
                  },
                },
                select: requestDecisionScopeSelect,
              });
            if (!candidate || !isSupportedRowType(candidate.requestType)) throw notFound();

            const storeId = deriveUniqueScheduledStore(
              candidate.employee.shiftAssignments,
              candidate.employee.storeAssignments.map(
                ({ storeId: employeeStoreId }) => employeeStoreId,
              ),
              candidate.startDate,
              candidate.endDate,
            );
            if (!hasRelevantAssignedStore(candidate, allowedStoreIds)) throw notFound();
            if (storeId === null) {
              throw new AppError(
                403,
                'REQUEST_REQUIRES_ADMIN',
                'Jadwal toko tidak tunggal; minta Admin meninjau.',
              );
            }
            if (!allowedStoreIds.includes(storeId)) throw notFound();

            // Check request state only after the Supervisor's store scope is proven.
            if (candidate.status !== RequestStatus.PENDING) throw decisionConflict();
            if (candidate.requestType === RequestType.OVERTIME) {
              throw new AppError(
                403,
                'REQUEST_REQUIRES_ADMIN',
                'Pengajuan lembur hanya dapat diputuskan oleh Admin.',
              );
            }

            // Sensitive request details are read only after authorization succeeds.
            row = await transaction.attendanceRequest.findUnique({
              where: { id: candidate.id },
              select: requestSelect,
            });
          } else {
            row = await transaction.attendanceRequest.findFirst({
              where: { id: input.requestId, requestType: { in: allowedTypes } },
              select: requestSelect,
            });
          }

          if (!row || !isSupportedRowType(row.requestType)) throw notFound();
          if (row.status !== RequestStatus.PENDING) throw decisionConflict();

          const updated = await transaction.attendanceRequest.updateMany({
            where: {
              id: row.id,
              status: RequestStatus.PENDING,
              requestType: { in: allowedTypes },
            },
            data: {
              status: input.decision,
              approverUserAccountId: input.actor.userAccountId,
              decisionAt: input.decidedAt,
              decisionNote: input.decisionNote,
            },
          });
          if (updated.count !== 1) throw decisionConflict();
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: input.actor.userAccountId,
              action:
                input.decision === RequestStatus.APPROVED
                  ? 'attendance_request.approve'
                  : 'attendance_request.reject',
              entityType: 'attendance_request',
              entityId: row.id,
              beforeData: { status: RequestStatus.PENDING },
              afterData: {
                status: input.decision,
                decisionAt: input.decidedAt.toISOString(),
                requestType: row.requestType,
              },
              reason: input.decisionNote,
              requestId: input.auditRequestId,
            },
          });
          if (row.employee.accountId !== null) {
            const typeLabel: Record<EmployeeRequestType, string> = {
              LEAVE: 'izin',
              SICK: 'sakit',
              ANNUAL_LEAVE: 'cuti tahunan',
              OVERTIME: 'lembur',
            };
            const decisionText =
              input.decision === RequestStatus.APPROVED ? 'disetujui' : 'ditolak';
            await transaction.notification.create({
              data: {
                userAccountId: row.employee.accountId,
                kind: 'REQUEST_DECISION',
                title: `Pengajuan ${typeLabel[row.requestType as EmployeeRequestType]} ${decisionText}`,
                message: `Pengajuan ${typeLabel[row.requestType as EmployeeRequestType]} Anda ${decisionText}.`,
                payload: { attendanceRequestId: row.id, status: input.decision },
              },
            });
          }
          const result = await transaction.attendanceRequest.findUnique({
            where: { id: row.id },
            select: requestSelect,
          });
          const mapped = result ? mapRow(result) : null;
          if (!mapped) throw decisionConflict();
          return mapped;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw decisionConflict();
      }
      throw error;
    }
  }
}
