import { randomUUID } from 'node:crypto';

import { assertEphemeralDatabaseUrl, SmokeCheckError } from './postgres-smoke-guard.js';

const WORK_DATE = '2026-10-14'; // Wednesday, stable fixture date.

function requireCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SmokeCheckError(message);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new SmokeCheckError('DATABASE_URL is required for the isolated CI database.');
  }
  assertEphemeralDatabaseUrl(databaseUrl);

  const [
    { createPrismaClient },
    { PrismaDashboardRepository },
    {
      AccountStatus,
      AttendanceType,
      AttendanceValidationStatus,
      NetworkStatus,
      RequestStatus,
      RequestType,
      UserRole,
      ValidationMethod,
    },
  ] = await Promise.all([
    import('../src/db/prisma.js'),
    import('../src/modules/dashboard/prisma-repository.js'),
    import('../src/generated/prisma/enums.js'),
  ]);

  const prisma = createPrismaClient(databaseUrl);
  const suffix = randomUUID().replaceAll('-', '');
  const accountIds = [randomUUID(), randomUUID()] as const;
  const employeeIds = [randomUUID(), randomUUID()] as const;
  const shiftIds = [randomUUID(), randomUUID()] as const;
  const assignmentIds = [randomUUID(), randomUUID()] as const;
  const attendanceIds = [randomUUID(), randomUUID()] as const;
  const requestIds = [randomUUID(), randomUUID()] as const;
  const shiftNames = [`AUD-01 owner A ${suffix}`, `AUD-01 owner B ${suffix}`] as const;
  const usernames = [`aud01_a_${suffix}`, `aud01_b_${suffix}`] as const;
  const nicks = [`AUD01-A-${suffix}`, `AUD01-B-${suffix}`] as const;
  const workDate = new Date(`${WORK_DATE}T00:00:00.000Z`);
  const prismaTime = (time: string) => new Date(`1970-01-01T${time}.000Z`);

  try {
    await prisma.userAccount.createMany({
      data: accountIds.map((id, index) => ({
        id,
        username: usernames[index]!,
        passwordHash: 'not-used-by-dashboard-regression',
        role: UserRole.EMPLOYEE,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      })),
    });
    await prisma.employee.createMany({
      data: employeeIds.map((id, index) => ({
        id,
        accountId: accountIds[index]!,
        nik: nicks[index]!,
        fullName: `AUD-01 Employee ${index === 0 ? 'A' : 'B'} ${suffix}`,
      })),
    });
    await prisma.workShift.createMany({
      data: shiftIds.map((id, index) => ({
        id,
        name: shiftNames[index]!,
        startTime: prismaTime(index === 0 ? '09:00:00' : '10:00:00'),
        endTime: prismaTime(index === 0 ? '17:00:00' : '18:00:00'),
        workDays: [3],
      })),
    });
    await prisma.shiftAssignment.createMany({
      data: assignmentIds.map((id, index) => ({
        id,
        employeeId: employeeIds[index]!,
        workShiftId: shiftIds[index]!,
        effectiveFrom: workDate,
      })),
    });
    await prisma.attendance.createMany({
      data: attendanceIds.map((id, index) => ({
        id,
        employeeId: employeeIds[index]!,
        shiftAssignmentId: assignmentIds[index]!,
        workDate,
        type: AttendanceType.CHECK_IN,
        serverTime: new Date(`${WORK_DATE}T${index === 0 ? '09:05:00' : '10:05:00'}.000Z`),
        validationStatus: AttendanceValidationStatus.VALID,
        method: ValidationMethod.GPS,
        networkStatus: NetworkStatus.ONLINE,
        idempotencyKey: randomUUID(),
      })),
    });
    await prisma.attendanceRequest.createMany({
      data: requestIds.map((id, index) => ({
        id,
        employeeId: employeeIds[index]!,
        requestType: RequestType.LEAVE,
        startDate: workDate,
        endDate: workDate,
        reason: `AUD-01 isolated fixture ${index === 0 ? 'A' : 'B'}`,
        status: RequestStatus.PENDING,
      })),
    });

    const repository = new PrismaDashboardRepository(prisma);
    const ownerA = await repository.employeeDashboard({
      userAccountId: accountIds[0],
      employeeId: employeeIds[0],
      date: WORK_DATE,
      historyPage: 1,
      historyPageSize: 10,
      requestPage: 1,
      requestPageSize: 10,
    });

    requireCheck(
      ownerA.today.length === 1 &&
        ownerA.today[0]?.employeeId === employeeIds[0] &&
        ownerA.today[0]?.shiftAssignmentId === assignmentIds[0] &&
        ownerA.today[0]?.shiftName === shiftNames[0] &&
        ownerA.today[0]?.status === 'MISSING_CHECKOUT',
      'Employee A dashboard must return only A schedule and its actual attendance status.',
    );
    requireCheck(
      ownerA.history.items.length === 1 && ownerA.history.items[0]?.id === attendanceIds[0],
      'Employee A dashboard history must include A attendance and exclude B attendance.',
    );
    requireCheck(
      ownerA.requests.items.length === 1 && ownerA.requests.items[0]?.id === requestIds[0],
      'Employee A dashboard requests must include A request and exclude B request.',
    );

    const mismatchedOwner = await repository.employeeDashboard({
      userAccountId: accountIds[1],
      employeeId: employeeIds[0],
      date: WORK_DATE,
      historyPage: 1,
      historyPageSize: 10,
      requestPage: 1,
      requestPageSize: 10,
    });
    requireCheck(
      mismatchedOwner.today.length === 0 &&
        mismatchedOwner.history.items.length === 0 &&
        mismatchedOwner.requests.items.length === 0,
      'A mismatched employeeId and userAccountId pair must not expose any dashboard data.',
    );
  } finally {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.attendanceRequest.deleteMany({ where: { id: { in: [...requestIds] } } });
        await tx.attendance.deleteMany({ where: { id: { in: [...attendanceIds] } } });
        await tx.shiftAssignment.deleteMany({ where: { id: { in: [...assignmentIds] } } });
        await tx.workShift.deleteMany({ where: { id: { in: [...shiftIds] } } });
        await tx.employee.deleteMany({ where: { id: { in: [...employeeIds] } } });
        await tx.userAccount.deleteMany({ where: { id: { in: [...accountIds] } } });
      });
    } finally {
      await prisma.$disconnect();
    }
  }
}

try {
  await main();
  console.log(
    'Employee dashboard PostgreSQL regression passed: schedule/status, attendance history, requests, and the employee/account pair are owner-scoped.',
  );
} catch (error) {
  if (error instanceof SmokeCheckError) {
    console.error(`Employee dashboard PostgreSQL regression failed: ${error.message}`);
  } else {
    console.error(
      'Employee dashboard PostgreSQL regression failed; database and driver details were suppressed.',
    );
  }
  process.exitCode = 1;
}
