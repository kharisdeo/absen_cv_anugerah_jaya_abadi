import { createHash, randomUUID } from 'node:crypto';

import { AccountStatus, DeviceBindingStatus, UserRole } from '../src/generated/prisma/enums.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { getBusinessDateAndWeekday } from '../src/modules/time/index.js';
import { PrismaAttendanceAttemptRepository } from '../src/modules/attendance/prisma-repository.js';
import { PrismaDailyAttendanceRepository } from '../src/modules/daily-attendance/prisma-repository.js';
import type { CreateAttendanceAttemptData } from '../src/modules/attendance/index.js';

function assertDisposableDatabaseUrl(value: string | undefined): asserts value is string {
  if (!value) throw new Error('DATABASE_URL is required for the disposable regression database.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must target the exact disposable AUD-05 database.');
  }

  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== '5547' ||
    url.pathname !== '/aud05' ||
    url.username !== 'aud05' ||
    url.password !== 'aud05_test_only'
  ) {
    throw new Error('Refusing to run: DATABASE_URL is not the exact disposable AUD-05 database.');
  }
}

function requireCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function prismaTime(value: string): Date {
  return new Date(`1970-01-01T${value}.000Z`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assertDisposableDatabaseUrl(databaseUrl);

  const prisma = createPrismaClient(databaseUrl);
  const suffix = randomUUID().replaceAll('-', '');
  const accountId = randomUUID();
  const employeeId = randomUUID();
  const bindingId = randomUUID();
  const shiftId = randomUUID();
  const assignmentId = randomUUID();
  const idempotencyKey = randomUUID();
  const selfieReferenceHash = createHash('sha256').update(randomUUID()).digest('hex');
  const stagingKey = `aud05/staging/${suffix}`;
  const sealedKey = `aud05/sealed/${suffix}`;
  const requestId = randomUUID();

  try {
    await prisma.userAccount.create({
      data: {
        id: accountId,
        username: `aud05_${suffix}`,
        passwordHash: 'not-used-by-disposable-regression',
        role: UserRole.EMPLOYEE,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      },
    });
    await prisma.employee.create({
      data: {
        id: employeeId,
        accountId,
        nik: `AUD05-${suffix}`,
        fullName: `AUD-05 Regression ${suffix}`,
      },
    });
    await prisma.deviceBinding.create({
      data: {
        id: bindingId,
        employeeId,
        deviceIdHash: `aud05-device-${suffix}`,
        deviceName: 'Disposable AUD-05 regression device',
        status: DeviceBindingStatus.APPROVED,
        approvedAt: new Date(),
      },
    });
    await prisma.selfieUploadIntent.create({
      data: {
        referenceHash: selfieReferenceHash,
        employeeId,
        deviceBindingId: bindingId,
        objectKey: stagingKey,
        stagingObjectKey: stagingKey,
        sealedObjectKey: sealedKey,
        contentType: 'image/jpeg',
        declaredSizeBytes: 10 * 1024,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const data: CreateAttendanceAttemptData = {
      actor: {
        userAccountId: accountId,
        role: UserRole.EMPLOYEE,
        employeeId,
        deviceBindingId: bindingId,
      },
      idempotencyKey,
      requestFingerprint: createHash('sha256').update(`aud05-${suffix}`).digest('hex'),
      storeIdHint: null,
      type: 'CHECK_IN',
      clientRecordedAt: new Date(),
      networkStatus: 'ONLINE',
      reportedMethod: 'GPS',
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      locationFailureReason: 'TIMEOUT',
      selfieReferenceHash,
      selfieStagedObjectKey: stagingKey,
      selfieSealedObjectKey: sealedKey,
      selfieSizeBytes: 10 * 1024,
      selfieRetentionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      livenessFaceDetectedClaim: true,
      livenessPassedClaim: true,
      clientIp: '203.0.113.5',
      requestId,
    };

    const attempts = new PrismaAttendanceAttemptRepository(prisma);
    const first = await attempts.createAttempt(data);
    requireCheck(first.created, 'The first GPS-failure submission must be created.');
    requireCheck(
      first.record.processingStatus === 'RECEIVED' &&
        first.record.locationFailureReason === 'TIMEOUT' &&
        first.record.attendanceId === null &&
        first.record.attendanceValidationStatus === null,
      'A no-fix attempt must remain RECEIVED and must not become a VALID attendance.',
    );

    const replay = await attempts.createAttempt(data);
    requireCheck(
      !replay.created && replay.record.id === first.record.id,
      'A replay with the same employee and idempotency key must return the original attempt.',
    );
    requireCheck(
      (await attempts.findByIdempotencyKey(randomUUID(), idempotencyKey)) === null,
      'An attempt must not be readable through a different employee owner scope.',
    );

    const stored = await prisma.attendanceAttempt.findUniqueOrThrow({
      where: { id: first.record.id },
      select: {
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        geofenceResult: true,
        locationFailureReason: true,
      },
    });
    requireCheck(
      stored.latitude === null &&
        stored.longitude === null &&
        stored.accuracyMeters === null &&
        stored.geofenceResult === null &&
        stored.locationFailureReason === 'TIMEOUT',
      'The persisted no-fix row must contain no fabricated coordinates or geofence result.',
    );

    const attachedIntent = await prisma.selfieUploadIntent.findUniqueOrThrow({
      where: { referenceHash: selfieReferenceHash },
      select: { status: true, attachedAttemptId: true, objectKey: true },
    });
    requireCheck(
      attachedIntent.status === 'ATTACHED' &&
        attachedIntent.attachedAttemptId === first.record.id &&
        attachedIntent.objectKey === sealedKey,
      'The private selfie intent must be sealed and attached to the pending attempt.',
    );
    requireCheck(
      (await prisma.attendance.count({ where: { sourceAttemptId: first.record.id } })) === 0 &&
        (await prisma.locationProof.count()) === 0 &&
        (await prisma.selfieCapture.count()) === 0,
      'A GPS-failure receipt must not create Attendance, LocationProof, or SelfieCapture records.',
    );

    const { businessDate, weekday } = getBusinessDateAndWeekday(first.record.receivedAt);
    const workDate = new Date(`${businessDate}T00:00:00.000Z`);
    await prisma.workShift.create({
      data: {
        id: shiftId,
        name: `AUD-05 guard ${suffix}`,
        startTime: prismaTime('00:00:00'),
        endTime: prismaTime('23:59:59'),
        workDays: [weekday],
      },
    });
    await prisma.shiftAssignment.create({
      data: { id: assignmentId, employeeId, workShiftId: shiftId, effectiveFrom: workDate },
    });

    const daily = new PrismaDailyAttendanceRepository(prisma);
    const absenceResult = await daily.markAbsentIfEligible({
      shift: {
        employeeId,
        shiftAssignmentId: assignmentId,
        storeId: null,
        workDate: businessDate,
        startTime: '00:00:00',
        endTime: '23:59:59',
        workDays: [weekday],
        holidayDates: [],
        hasAmbiguousStoreHoliday: false,
      },
      evaluatedAt: new Date(first.record.receivedAt.getTime() + 36 * 60 * 60 * 1000),
    });
    requireCheck(
      absenceResult === 'blocked' &&
        (await prisma.dailyAttendance.count({ where: { employeeId, workDate } })) === 0,
      'A pending GPS-failure attempt inside the shift window must block a false ABSENT status.',
    );
  } finally {
    // Audit rows are append-only, so this test intentionally relies on a fresh disposable DB.
    await prisma.$disconnect();
  }
}

try {
  await main();
  console.log(
    'AUD-05 PostgreSQL regression passed: no-fix attempt/selfie persistence, replay owner scope, and false-ABSENT guard.',
  );
} catch (error) {
  const detail =
    error instanceof Error
      ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database URL redacted]')
      : 'Unknown regression failure.';
  console.error(`AUD-05 PostgreSQL regression failed: ${detail}`);
  process.exitCode = 1;
}
