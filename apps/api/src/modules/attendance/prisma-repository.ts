import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  AttendanceValidationStatus,
  GeofenceResult,
  NetworkStatus,
  ValidationMethod,
} from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type {
  AttendanceAttemptRecord,
  AttendanceAttemptRepository,
  CreateAttendanceAttemptData,
} from './index.js';
import { assessGeospatialAttempt, type ActiveAssignedStore } from './geospatial-validation.js';
import {
  assertCheckoutFollowsCheckIn,
  assertNoValidCheckInDuplicate,
  assessAttendanceTiming,
  attendanceBusinessRuleError,
  businessDateTime,
  isAttendanceBusinessRuleErrorCode,
} from './business-rules.js';
import { getBusinessDateAndWeekday, isWorkingDay, resolveShiftEnd } from '../time/index.js';
import { assessOfflineSyncTime } from './offline-sync.js';
import { dailyStatusForAttendance } from '../daily-attendance/index.js';

const attemptSelect = {
  id: true,
  employeeId: true,
  deviceBindingId: true,
  type: true,
  idempotencyKey: true,
  requestFingerprint: true,
  deviceIdHash: true,
  receivedAt: true,
  processingStatus: true,
  processingErrorCode: true,
  locationFailureReason: true,
  attendance: { select: { id: true, validationStatus: true } },
} as const;

type AttendanceAttemptRow = Prisma.AttendanceAttemptGetPayload<{
  select: typeof attemptSelect;
}>;
type AttendanceTransaction = Prisma.TransactionClient;

type AssignedShiftRow = Readonly<{
  id: string;
  storeId: string | null;
  startTime: string;
  endTime: string;
  lateToleranceMinutes: number;
  workDays: number[];
}>;

type OpenCheckInRow = Readonly<{
  id: string;
  shiftAssignmentId: string | null;
  workDate: string;
  serverTime: Date;
  validationStatus: 'VALID' | 'PENDING_VERIFICATION' | 'APPROVED' | 'REJECTED' | 'PENDING_OFFLINE';
  recordStatus: 'ACTIVE' | 'SUPERSEDED';
  storeId: string | null;
}>;

function dateAtUtcMidnight(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function resolveAssignedShift(
  transaction: AttendanceTransaction,
  employeeId: string,
  workDate: string,
  storeId: string | null,
): Promise<AssignedShiftRow> {
  const assignments = await transaction.$queryRaw<readonly AssignedShiftRow[]>(Prisma.sql`
    SELECT
      sa.id::text AS "id",
      sa.store_id::text AS "storeId",
      ws.start_time::text AS "startTime",
      ws.end_time::text AS "endTime",
      ws.late_tolerance_minutes AS "lateToleranceMinutes",
      ws.work_days AS "workDays"
    FROM shift_assignments AS sa
    INNER JOIN work_shifts AS ws ON ws.id = sa.work_shift_id
    WHERE sa.employee_id = ${employeeId}::uuid
      AND sa.effective_from <= ${workDate}::date
      AND (sa.effective_to IS NULL OR sa.effective_to >= ${workDate}::date)
      AND ws.is_active = TRUE
      AND (${storeId}::uuid IS NULL OR sa.store_id IS NULL OR sa.store_id = ${storeId}::uuid)
    ORDER BY sa.id
    FOR SHARE OF sa, ws
  `);

  if (assignments.length === 0) throw attendanceBusinessRuleError('ATTENDANCE_SHIFT_NOT_ASSIGNED');

  const holidays = await transaction.$queryRaw<readonly { storeId: string | null }[]>(Prisma.sql`
    SELECT store_id::text AS "storeId"
    FROM holidays
    WHERE holiday_date = ${workDate}::date
  `);
  const workingAssignments = assignments.filter((assignment) => {
    const assignmentStoreId = assignment.storeId ?? storeId;
    const applicableHolidays = holidays
      .filter((holiday) => holiday.storeId === null || holiday.storeId === assignmentStoreId)
      .map(() => workDate);
    return isWorkingDay(workDate, assignment.workDays, applicableHolidays);
  });

  if (workingAssignments.length === 0)
    throw attendanceBusinessRuleError('ATTENDANCE_NON_WORKING_DAY');
  if (workingAssignments.length > 1)
    throw attendanceBusinessRuleError('ATTENDANCE_SHIFT_AMBIGUOUS');

  return workingAssignments[0]!;
}

function previousBusinessDate(workDate: string): string {
  const [year, month, day] = workDate.split('-').map(Number);
  const previous = new Date(0);
  previous.setUTCFullYear(year!, month! - 1, day! - 1);
  previous.setUTCHours(0, 0, 0, 0);
  return previous.toISOString().slice(0, 10);
}

async function findAssignedShiftById(
  transaction: AttendanceTransaction,
  shiftAssignmentId: string,
  workDate: string,
): Promise<AssignedShiftRow | null> {
  const assignments = await transaction.$queryRaw<readonly AssignedShiftRow[]>(Prisma.sql`
    SELECT
      sa.id::text AS "id",
      sa.store_id::text AS "storeId",
      ws.start_time::text AS "startTime",
      ws.end_time::text AS "endTime",
      ws.late_tolerance_minutes AS "lateToleranceMinutes",
      ws.work_days AS "workDays"
    FROM shift_assignments AS sa
    INNER JOIN work_shifts AS ws ON ws.id = sa.work_shift_id
    WHERE sa.id = ${shiftAssignmentId}::uuid
      AND sa.effective_from <= ${workDate}::date
      AND (sa.effective_to IS NULL OR sa.effective_to >= ${workDate}::date)
    FOR SHARE OF sa, ws
  `);
  return assignments[0] ?? null;
}

async function findOpenCheckIns(
  transaction: AttendanceTransaction,
  employeeId: string,
  workDate: string,
): Promise<readonly OpenCheckInRow[]> {
  return transaction.$queryRaw<readonly OpenCheckInRow[]>(Prisma.sql`
    SELECT
      a.id::text AS "id",
      a.shift_assignment_id::text AS "shiftAssignmentId",
      a.work_date::text AS "workDate",
      a.server_time AS "serverTime",
      a.validation_status::text AS "validationStatus",
      a.record_status::text AS "recordStatus",
      a.store_id::text AS "storeId"
    FROM attendances AS a
    WHERE a.employee_id = ${employeeId}::uuid
      AND a.work_date = ${workDate}::date
      AND a.type = 'CHECK_IN'
      AND a.record_status = 'ACTIVE'
      AND a.validation_status <> 'REJECTED'
      AND NOT EXISTS (
        SELECT 1
        FROM attendances AS checkout
        WHERE checkout.employee_id = a.employee_id
          AND checkout.work_date = a.work_date
          AND checkout.shift_assignment_id = a.shift_assignment_id
          AND checkout.type = 'CHECK_OUT'
          AND checkout.record_status = 'ACTIVE'
          AND checkout.validation_status <> 'REJECTED'
      )
    ORDER BY a.server_time DESC, a.id
    FOR UPDATE OF a
  `);
}

async function hasValidAttendance(
  transaction: AttendanceTransaction,
  employeeId: string,
  workDate: string,
  type: 'CHECK_IN' | 'CHECK_OUT',
): Promise<boolean> {
  const rows = await transaction.$queryRaw<readonly { duplicate: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM attendances
      WHERE employee_id = ${employeeId}::uuid
        AND work_date = ${workDate}::date
        AND type = ${type}::attendance_type
        AND record_status = 'ACTIVE'
        -- A provisional check-in can later be approved, so it must block a
        -- duplicate while verification is pending. Rejected records do not.
        AND validation_status <> 'REJECTED'
    ) AS "duplicate"
  `);
  return rows[0]?.duplicate ?? false;
}

async function hasApprovedLeave(
  transaction: AttendanceTransaction,
  employeeId: string,
  workDate: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<readonly { approved: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM attendance_requests
      WHERE employee_id = ${employeeId}::uuid
        AND status = 'APPROVED'
        AND request_type IN ('LEAVE', 'SICK', 'ANNUAL_LEAVE')
        AND start_date <= ${workDate}::date
        AND end_date >= ${workDate}::date
    ) AS "approved"
  `);
  return rows[0]?.approved ?? false;
}

function mapAttempt(row: AttendanceAttemptRow): AttendanceAttemptRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    deviceBindingId: row.deviceBindingId,
    type: row.type,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    deviceIdHash: row.deviceIdHash,
    receivedAt: row.receivedAt,
    processingStatus: row.processingStatus,
    processingErrorCode: row.processingErrorCode,
    locationFailureReason: row.locationFailureReason,
    attendanceId: row.attendance?.id ?? null,
    attendanceValidationStatus: row.attendance?.validationStatus ?? null,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function findAttempt(
  client: PrismaClient | AttendanceTransaction,
  employeeId: string,
  idempotencyKey: string,
): Promise<AttendanceAttemptRecord | null> {
  const row = await client.attendanceAttempt.findUnique({
    where: { employeeId_idempotencyKey: { employeeId, idempotencyKey } },
    select: attemptSelect,
  });
  return row ? mapAttempt(row) : null;
}

export class PrismaAttendanceAttemptRepository implements AttendanceAttemptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByIdempotencyKey(employeeId: string, idempotencyKey: string) {
    return findAttempt(this.prisma, employeeId, idempotencyKey);
  }

  async createAttempt(data: CreateAttendanceAttemptData) {
    try {
      let location: Readonly<{
        latitude: number;
        longitude: number;
        accuracyMeters: number;
      }> | null;
      if (data.latitude === null || data.longitude === null || data.accuracyMeters === null) {
        if (
          data.latitude !== null ||
          data.longitude !== null ||
          data.accuracyMeters !== null ||
          !data.locationFailureReason
        ) {
          throw new AppError(
            400,
            'INVALID_ATTENDANCE_ATTEMPT',
            'Bukti lokasi percobaan absensi tidak konsisten.',
          );
        }
        location = null;
      } else {
        if (data.locationFailureReason) {
          throw new AppError(
            400,
            'INVALID_ATTENDANCE_ATTEMPT',
            'Bukti lokasi percobaan absensi tidak konsisten.',
          );
        }
        location = {
          latitude: data.latitude,
          longitude: data.longitude,
          accuracyMeters: data.accuracyMeters,
        };
      }

      return await this.prisma.$transaction(async (transaction) => {
        const bindings = await transaction.$queryRaw<
          readonly { deviceIdHash: string; fullName: string }[]
        >(Prisma.sql`
          SELECT b.device_id_hash AS "deviceIdHash", e.full_name AS "fullName"
          FROM device_bindings AS b
          INNER JOIN employees AS e ON e.id = b.employee_id
          WHERE b.id = ${data.actor.deviceBindingId}::uuid
            AND b.employee_id = ${data.actor.employeeId}::uuid
            AND b.status = 'APPROVED'
            AND e.status = 'ACTIVE'
          FOR SHARE OF b
          FOR UPDATE OF e
        `);
        const binding = bindings[0];
        if (!binding) {
          throw new AppError(
            403,
            'ATTENDANCE_DEVICE_BINDING_REQUIRED',
            'Profil karyawan aktif dan perangkat yang disetujui diperlukan.',
          );
        }

        // Assignment and store configuration are read and locked in the same
        // transaction as the attempt insert. Inactive stores are never eligible.
        const assignedStoreRows = location
          ? await transaction.$queryRaw<
              readonly Readonly<{
                id: string;
                latitude: string;
                longitude: string;
                radiusMeters: number;
                accuracyLimitMeters: number;
              }>[]
            >(Prisma.sql`
              SELECT
                s.id::text AS "id",
                s.latitude::text AS "latitude",
                s.longitude::text AS "longitude",
                s.radius_meters AS "radiusMeters",
                s.accuracy_limit_meters AS "accuracyLimitMeters"
              FROM employee_stores AS es
              INNER JOIN stores AS s ON s.id = es.store_id
              WHERE es.employee_id = ${data.actor.employeeId}::uuid
                AND s.is_active = TRUE
              ORDER BY s.id
              FOR SHARE OF es, s
            `)
          : [];
        const stores: ActiveAssignedStore[] = assignedStoreRows.map((store) => ({
          ...store,
          latitude: Number(store.latitude),
          longitude: Number(store.longitude),
        }));

        // Locking the employee row above serializes this existence check with
        // other attempts for the same employee, so concurrent identical fixes
        // cannot both escape the repeated-coordinate flag.
        const repeatedCoordinateRows = location
          ? await transaction.$queryRaw<readonly { repeatedCoordinate: boolean }[]>(Prisma.sql`
              SELECT EXISTS (
                SELECT 1
                FROM attendance_attempts
                WHERE employee_id = ${data.actor.employeeId}::uuid
                  AND latitude = ${location.latitude}::numeric
                  AND longitude = ${location.longitude}::numeric
              ) AS "repeatedCoordinate"
            `)
          : [];
        const geospatial = location
          ? assessGeospatialAttempt({
              stores,
              storeIdHint: data.storeIdHint,
              ...location,
              repeatedCoordinate: repeatedCoordinateRows[0]?.repeatedCoordinate ?? false,
            })
          : {
              storeId: null,
              distanceMeters: null,
              radiusMeters: null,
              accuracyLimitMeters: null,
              result: null,
              repeatedCoordinate: false,
            };

        const row = await transaction.attendanceAttempt.create({
          data: {
            employee: { connect: { id: data.actor.employeeId } },
            deviceBinding: { connect: { id: data.actor.deviceBindingId } },
            type: data.type,
            clientRecordedAt: data.clientRecordedAt,
            networkStatus: data.networkStatus,
            reportedMethod: data.reportedMethod,
            latitude: location?.latitude ?? null,
            longitude: location?.longitude ?? null,
            accuracyMeters: location?.accuracyMeters ?? null,
            locationFailureReason: data.locationFailureReason,
            ...(geospatial.storeId ? { store: { connect: { id: geospatial.storeId } } } : {}),
            distanceMeters: geospatial.distanceMeters,
            geofenceRadiusMeters: geospatial.radiusMeters,
            accuracyLimitMeters: geospatial.accuracyLimitMeters,
            geofenceResult: geospatial.result,
            repeatedCoordinate: geospatial.repeatedCoordinate,
            selfieReferenceHash: data.selfieReferenceHash,
            selfieSizeBytes: data.selfieSizeBytes,
            livenessFaceDetectedClaim: data.livenessFaceDetectedClaim,
            livenessPassedClaim: data.livenessPassedClaim,
            idempotencyKey: data.idempotencyKey,
            requestFingerprint: data.requestFingerprint,
            deviceIdHash: binding.deviceIdHash,
            clientIp: data.clientIp,
          },
          select: attemptSelect,
        });

        const isOffline = data.networkStatus === NetworkStatus.OFFLINE;
        // The current private-image verifier validates bytes and ownership only. Liveness
        // fields are client claims and SelfieCapture is deliberately stored as unverified.
        const hasTrustedLivenessEvidence = false;
        const offlineNeedsVerification =
          isOffline &&
          (!hasTrustedLivenessEvidence ||
            (data.reportedMethod !== ValidationMethod.GPS &&
              data.reportedMethod !== ValidationMethod.OFFLINE) ||
            geospatial.result !== GeofenceResult.WITHIN_LIMITS ||
            geospatial.repeatedCoordinate ||
            assessOfflineSyncTime(data.clientRecordedAt, row.receivedAt).requiresVerification);
        const validationStatus =
          isOffline && !offlineNeedsVerification
            ? AttendanceValidationStatus.VALID
            : AttendanceValidationStatus.PENDING_VERIFICATION;
        const attendanceMethod = isOffline ? ValidationMethod.OFFLINE : data.reportedMethod;

        // Consume the staged evidence exactly once in the same transaction as the
        // immutable attempt receipt. The private sealed copy is what later review
        // and attendance promotion must use; the signed staging URL cannot mutate it.
        const attachedIntent = await transaction.selfieUploadIntent.updateMany({
          where: {
            referenceHash: data.selfieReferenceHash,
            employeeId: data.actor.employeeId,
            deviceBindingId: data.actor.deviceBindingId,
            objectKey: data.selfieStagedObjectKey,
            sealedObjectKey: data.selfieSealedObjectKey,
            status: 'PENDING',
            purgeClaimedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: {
            objectKey: data.selfieSealedObjectKey,
            sealedObjectKey: null,
            status: 'ATTACHED',
            attachedAttemptId: row.id,
            retentionExpiresAt: data.selfieRetentionExpiresAt,
            watermarkMetadata: {
              employeeName: binding.fullName,
              serverTime: row.receivedAt.toISOString(),
              ...(location
                ? { latitude: location.latitude, longitude: location.longitude }
                : { locationFailureReason: data.locationFailureReason }),
            },
          },
        });
        if (attachedIntent.count !== 1) {
          throw new AppError(
            422,
            'ATTENDANCE_EVIDENCE_INVALID',
            'Referensi bukti absensi tidak valid.',
          );
        }

        // Preserve the raw attempt independently from the attendance event that follows.
        await transaction.auditLog.create({
          data: {
            actorUserAccountId: data.actor.userAccountId,
            action: 'attendance.attempt.create',
            entityType: 'attendance_attempt',
            entityId: row.id,
            afterData: {
              state: 'RECEIVED',
              type: data.type,
              networkStatus: data.networkStatus,
              reportedMethod: data.reportedMethod,
            },
            reason: null,
            clientIp: data.clientIp,
            deviceIdHash: binding.deviceIdHash,
            requestId: data.requestId,
          },
        });

        // A no-fix submission is a durable, owner-scoped pending receipt, not an
        // attendance event. Keep the staged selfie attached to this attempt and
        // leave it RECEIVED so the daily-status guard suppresses a false ABSENT.
        if (!location) return { record: mapAttempt(row), created: true } as const;

        const receivedBusinessDate = getBusinessDateAndWeekday(row.receivedAt).businessDate;
        let workDate = receivedBusinessDate;
        let shift: AssignedShiftRow;
        let checkIn: OpenCheckInRow | null = null;
        let timing: ReturnType<typeof assessAttendanceTiming>;

        try {
          if (data.type === 'CHECK_IN') {
            shift = await resolveAssignedShift(
              transaction,
              data.actor.employeeId,
              workDate,
              geospatial.storeId,
            );
            assertNoValidCheckInDuplicate(
              await hasValidAttendance(transaction, data.actor.employeeId, workDate, 'CHECK_IN'),
            );
            timing = assessAttendanceTiming({
              workDate,
              shiftStart: shift.startTime,
              shiftEnd: shift.endTime,
              toleranceMinutes: shift.lateToleranceMinutes,
              checkInServerTime: row.receivedAt,
              checkOutServerTime: null,
              hasApprovedLeave: false,
            });
          } else {
            const sameDateCheckIns = await findOpenCheckIns(
              transaction,
              data.actor.employeeId,
              receivedBusinessDate,
            );
            if (sameDateCheckIns.length > 1) {
              throw attendanceBusinessRuleError('ATTENDANCE_SHIFT_AMBIGUOUS');
            }

            if (sameDateCheckIns.length === 1) {
              try {
                shift = await resolveAssignedShift(
                  transaction,
                  data.actor.employeeId,
                  receivedBusinessDate,
                  geospatial.storeId,
                );
              } catch (error) {
                if (
                  error instanceof AppError &&
                  (error.code === 'ATTENDANCE_SHIFT_NOT_ASSIGNED' ||
                    error.code === 'ATTENDANCE_NON_WORKING_DAY')
                ) {
                  throw attendanceBusinessRuleError('ATTENDANCE_CHECKOUT_SHIFT_MISMATCH');
                }
                throw error;
              }
              checkIn = sameDateCheckIns[0]!;
              if (checkIn.shiftAssignmentId !== shift.id) {
                throw attendanceBusinessRuleError('ATTENDANCE_CHECKOUT_SHIFT_MISMATCH');
              }
            } else {
              const previousDate = previousBusinessDate(receivedBusinessDate);
              const previousDateCheckIns = await findOpenCheckIns(
                transaction,
                data.actor.employeeId,
                previousDate,
              );
              const overnightCandidates: Array<{
                checkIn: OpenCheckInRow;
                shift: AssignedShiftRow;
              }> = [];
              let expiredOvernightCheckIn = false;

              for (const candidate of previousDateCheckIns) {
                if (!candidate.shiftAssignmentId) continue;
                const candidateShift = await findAssignedShiftById(
                  transaction,
                  candidate.shiftAssignmentId,
                  candidate.workDate,
                );
                if (!candidateShift || candidateShift.endTime >= candidateShift.startTime) {
                  continue;
                }
                const scheduledEnd = resolveShiftEnd(
                  candidate.workDate,
                  candidateShift.startTime,
                  candidateShift.endTime,
                );
                if (scheduledEnd.businessDate !== receivedBusinessDate) continue;
                const scheduledEndInstant = businessDateTime(
                  scheduledEnd.businessDate,
                  scheduledEnd.clockTime,
                );
                if (row.receivedAt.getTime() > scheduledEndInstant.getTime()) {
                  expiredOvernightCheckIn = true;
                  continue;
                }
                overnightCandidates.push({ checkIn: candidate, shift: candidateShift });
              }

              if (overnightCandidates.length > 1) {
                throw attendanceBusinessRuleError('ATTENDANCE_SHIFT_AMBIGUOUS');
              }
              const overnight = overnightCandidates[0];
              if (!overnight) {
                throw attendanceBusinessRuleError(
                  expiredOvernightCheckIn
                    ? 'ATTENDANCE_CHECKOUT_WINDOW_EXPIRED'
                    : 'ATTENDANCE_CHECK_IN_REQUIRED',
                );
              }
              checkIn = overnight.checkIn;
              shift = overnight.shift;
              workDate = checkIn.workDate;
            }

            assertCheckoutFollowsCheckIn({
              checkIn,
              shiftAssignmentId: shift.id,
              workDate,
              serverTime: row.receivedAt,
            });
            if (
              (geospatial.storeId && checkIn.storeId && geospatial.storeId !== checkIn.storeId) ||
              (data.storeIdHint && checkIn.storeId && data.storeIdHint !== checkIn.storeId)
            ) {
              throw attendanceBusinessRuleError('ATTENDANCE_CHECKOUT_SHIFT_MISMATCH');
            }
            timing = assessAttendanceTiming({
              workDate,
              shiftStart: shift.startTime,
              shiftEnd: shift.endTime,
              toleranceMinutes: shift.lateToleranceMinutes,
              checkInServerTime: checkIn.serverTime,
              checkOutServerTime: row.receivedAt,
              hasApprovedLeave: await hasApprovedLeave(
                transaction,
                data.actor.employeeId,
                workDate,
              ),
            });
          }
        } catch (error) {
          if (!(error instanceof AppError) || !isAttendanceBusinessRuleErrorCode(error.code)) {
            throw error;
          }

          const rejected = await transaction.attendanceAttempt.update({
            where: { id: row.id },
            data: {
              processingStatus: 'RULE_REJECTED',
              processingErrorCode: error.code,
            },
            select: attemptSelect,
          });
          await transaction.auditLog.create({
            data: {
              actorUserAccountId: data.actor.userAccountId,
              action: 'attendance.attempt.rule_rejected',
              entityType: 'attendance_attempt',
              entityId: row.id,
              afterData: { state: 'RULE_REJECTED', code: error.code },
              reason: null,
              clientIp: data.clientIp,
              deviceIdHash: binding.deviceIdHash,
              requestId: data.requestId,
            },
          });
          return { record: mapAttempt(rejected), created: true } as const;
        }

        const intent = await transaction.selfieUploadIntent.findUnique({
          where: { referenceHash: data.selfieReferenceHash },
          select: {
            objectKey: true,
            contentType: true,
            status: true,
            watermarkMetadata: true,
          },
        });
        if (
          !intent ||
          intent.status !== 'ATTACHED' ||
          intent.objectKey !== data.selfieSealedObjectKey
        ) {
          throw new AppError(
            422,
            'ATTENDANCE_EVIDENCE_INVALID',
            'Referensi bukti absensi tidak valid.',
          );
        }

        const attendanceStoreId = checkIn?.storeId ?? shift.storeId ?? geospatial.storeId;
        const attendance = await transaction.attendance.create({
          data: {
            employeeId: data.actor.employeeId,
            ...(attendanceStoreId ? { storeId: attendanceStoreId } : {}),
            shiftAssignmentId: shift.id,
            sourceAttemptId: row.id,
            workDate: dateAtUtcMidnight(workDate),
            type: data.type,
            serverTime: row.receivedAt,
            deviceTime: data.clientRecordedAt,
            validationStatus,
            recordStatus: 'ACTIVE',
            method: attendanceMethod,
            networkStatus: data.networkStatus,
            idempotencyKey: data.idempotencyKey,
            deviceIdHash: binding.deviceIdHash,
            clientIp: data.clientIp,
          },
          select: { id: true, validationStatus: true },
        });
        await transaction.selfieCapture.create({
          data: {
            attendanceId: attendance.id,
            objectKey: data.selfieSealedObjectKey,
            contentType: intent.contentType,
            sizeBytes: data.selfieSizeBytes,
            ...(intent.watermarkMetadata === null
              ? {}
              : { watermarkMetadata: intent.watermarkMetadata as Prisma.InputJsonValue }),
            faceDetected: false,
            livenessPassed: false,
            capturedAt: data.clientRecordedAt,
            retentionExpiresAt: data.selfieRetentionExpiresAt,
          },
        });
        await transaction.locationProof.create({
          data: {
            attendanceId: attendance.id,
            latitude: location.latitude,
            longitude: location.longitude,
            accuracyMeters: location.accuracyMeters,
            ...(geospatial.distanceMeters === null
              ? {}
              : { distanceMeters: geospatial.distanceMeters }),
            isMocked: false,
            source: attendanceMethod,
            capturedAt: data.clientRecordedAt,
          },
        });

        // Attendance creation holds the employee row lock from the start of this
        // transaction. This serializes reconciliation with the absent job, which
        // uses the same lock, and only changes the derived row for this exact
        // assignment/date. The raw attendance and attempt remain immutable here.
        const dailyStatus = dailyStatusForAttendance(attendance.validationStatus, timing.isLate);
        if (dailyStatus) {
          await transaction.$executeRaw(Prisma.sql`
            UPDATE daily_attendance_statuses
            SET status = ${dailyStatus}::daily_attendance_status,
                evaluated_at = ${row.receivedAt},
                updated_at = ${row.receivedAt}
            WHERE employee_id = ${data.actor.employeeId}::uuid
              AND shift_assignment_id = ${shift.id}::uuid
              AND work_date = ${workDate}::date
              AND status = 'ABSENT'
              AND corrected_by_attendance_correction_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM monthly_recaps AS recap
                WHERE recap.employee_id = ${data.actor.employeeId}::uuid
                  AND recap.period_start = date_trunc('month', ${workDate}::date)::date
                  AND recap.status = 'CLOSED'
                  AND (
                    recap.store_id IS NULL
                    OR recap.store_id = ${attendanceStoreId}::uuid
                    OR ${attendanceStoreId}::uuid IS NULL
                  )
              )
          `);
        }

        await transaction.attendanceAttempt.update({
          where: { id: row.id },
          data: { processingStatus: 'RECORDED', processingErrorCode: null },
          select: attemptSelect,
        });
        await transaction.auditLog.create({
          data: {
            actorUserAccountId: data.actor.userAccountId,
            action: 'attendance.record.create',
            entityType: 'attendance',
            entityId: attendance.id,
            afterData: {
              attemptId: row.id,
              type: data.type,
              state: attendance.validationStatus,
              workDate,
              isLate: timing.isLate,
              minutesAfterScheduledStart: timing.minutesAfterScheduledStart,
              isEarlyLeave: timing.isEarlyLeave,
              missingCheckout: timing.missingCheckout,
            },
            reason: null,
            clientIp: data.clientIp,
            deviceIdHash: binding.deviceIdHash,
            requestId: data.requestId,
          },
        });

        if (attendance.validationStatus === 'PENDING_VERIFICATION') {
          const administrators = await transaction.userAccount.findMany({
            where: { role: 'ADMIN', status: 'ACTIVE' },
            select: { id: true },
          });
          if (administrators.length > 0) {
            await transaction.notification.createMany({
              data: administrators.map(({ id }) => ({
                userAccountId: id,
                kind: 'ATTENDANCE_VERIFICATION',
                title: 'Absensi menunggu verifikasi',
                message: 'Ada absensi yang menunggu verifikasi.',
                payload: { attendanceId: attendance.id },
              })),
            });
          }
        }

        const processedAttempt = await transaction.attendanceAttempt.findUnique({
          where: { id: row.id },
          select: attemptSelect,
        });
        if (!processedAttempt) {
          throw new AppError(
            500,
            'ATTENDANCE_ATTEMPT_NOT_FOUND',
            'Percobaan absensi tidak ditemukan.',
          );
        }
        return { record: mapAttempt(processedAttempt), created: true } as const;
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // The unique (employee_id, idempotency_key) index decides the race. Read the
      // committed winner only after PostgreSQL has rejected this transaction.
      const existing = await this.findByIdempotencyKey(data.actor.employeeId, data.idempotencyKey);
      if (existing) return { record: existing, created: false } as const;

      throw new AppError(
        409,
        'ATTENDANCE_ATTEMPT_CONFLICT',
        'Percobaan absensi tidak dapat dibuat karena terjadi konflik data.',
      );
    }
  }
}
