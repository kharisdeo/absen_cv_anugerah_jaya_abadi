import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AccountStatus,
  EmployeeStatus,
  RequestStatus,
  RequestType,
  UserRole,
} from '../src/generated/prisma/enums.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { argon2PasswordHasher } from '../src/modules/auth/argon2.js';
import {
  DemoSeedDataError,
  resolveDemoSeedConfiguration,
  safeDemoSeedFailureMessage,
} from './seed-policy.js';

const repositoryEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(repositoryEnvPath)) {
  process.loadEnvFile(repositoryEnvPath);
}

const ids = {
  adminOne: '10000000-0000-4000-8000-000000000001',
  adminTwo: '10000000-0000-4000-8000-000000000002',
  supervisorAccount: '10000000-0000-4000-8000-000000000003',
  employeeAccount: '10000000-0000-4000-8000-000000000004',
  supervisorEmployee: '20000000-0000-4000-8000-000000000001',
  employee: '20000000-0000-4000-8000-000000000002',
  store: '30000000-0000-4000-8000-000000000001',
  shift: '40000000-0000-4000-8000-000000000001',
  shiftAssignment: '50000000-0000-4000-8000-000000000001',
  holiday: '60000000-0000-4000-8000-000000000001',
  pendingRequest: '70000000-0000-4000-8000-000000000001',
} as const;

const fixture = {
  accounts: [
    { id: ids.adminOne, username: 'demo.admin.1', role: UserRole.ADMIN, employeeId: null },
    { id: ids.adminTwo, username: 'demo.admin.2', role: UserRole.ADMIN, employeeId: null },
    {
      id: ids.supervisorAccount,
      username: 'demo.supervisor',
      role: UserRole.SUPERVISOR,
      employeeId: ids.supervisorEmployee,
    },
    {
      id: ids.employeeAccount,
      username: 'demo.employee',
      role: UserRole.EMPLOYEE,
      employeeId: ids.employee,
    },
  ],
  employees: [
    {
      id: ids.supervisorEmployee,
      accountId: ids.supervisorAccount,
      nik: 'DEMO-SUP-001',
      fullName: 'DEMO Supervisor One (synthetic)',
      position: 'DEMO Supervisor',
    },
    {
      id: ids.employee,
      accountId: ids.employeeAccount,
      nik: 'DEMO-EMP-001',
      fullName: 'DEMO Employee One (synthetic)',
      position: 'DEMO Employee',
    },
  ],
} as const;

function businessDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function wallClock(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

async function main(): Promise<void> {
  const configuration = resolveDemoSeedConfiguration(process.env);
  const prisma = createPrismaClient(configuration.databaseUrl);

  try {
    const databaseIdentity = await prisma.$queryRaw<
      Array<{ databaseName: string; databaseUser: string }>
    >`SELECT current_database() AS "databaseName", current_user AS "databaseUser"`;
    if (
      databaseIdentity[0]?.databaseName !== 'absen_local_demo' ||
      databaseIdentity[0]?.databaseUser !== 'absen_local'
    ) {
      throw new DemoSeedDataError('Target PostgreSQL bukan database demo lokal yang diizinkan.');
    }

    const passwordHashes = {
      adminOne: await argon2PasswordHasher.hash(configuration.adminOnePassword),
      adminTwo: await argon2PasswordHasher.hash(configuration.adminTwoPassword),
      supervisor: await argon2PasswordHasher.hash(configuration.supervisorPassword),
      employee: await argon2PasswordHasher.hash(configuration.employeePassword),
    };

    await prisma.$transaction(async (transaction) => {
      const accountCollisions = await transaction.userAccount.findMany({
        where: {
          OR: [
            { id: { in: fixture.accounts.map((account) => account.id) } },
            { username: { in: fixture.accounts.map((account) => account.username) } },
          ],
        },
        select: { id: true, username: true, role: true },
      });
      for (const existing of accountCollisions) {
        const expected = fixture.accounts.find((account) => account.id === existing.id);
        if (
          !expected ||
          expected.username !== existing.username ||
          expected.role !== existing.role
        ) {
          throw new DemoSeedDataError(
            'Demo account ID/username bertabrakan dengan record non-demo.',
          );
        }
      }

      const employeeCollisions = await transaction.employee.findMany({
        where: {
          OR: [
            { id: { in: fixture.employees.map((employee) => employee.id) } },
            { nik: { in: fixture.employees.map((employee) => employee.nik) } },
            { accountId: { in: fixture.employees.map((employee) => employee.accountId) } },
          ],
        },
        select: { id: true, accountId: true, nik: true },
      });
      for (const existing of employeeCollisions) {
        const expected = fixture.employees.find((employee) => employee.id === existing.id);
        if (
          !expected ||
          expected.accountId !== existing.accountId ||
          expected.nik !== existing.nik
        ) {
          throw new DemoSeedDataError(
            'Demo employee ID/NIK/account bertabrakan dengan record non-demo.',
          );
        }
      }

      const accountPasswordHashes = [
        passwordHashes.adminOne,
        passwordHashes.adminTwo,
        passwordHashes.supervisor,
        passwordHashes.employee,
      ];
      for (const [index, account] of fixture.accounts.entries()) {
        const passwordHash = accountPasswordHashes[index];
        if (!passwordHash) throw new DemoSeedDataError('Hash password demo tidak tersedia.');
        await transaction.userAccount.upsert({
          where: { id: account.id },
          create: {
            id: account.id,
            username: account.username,
            passwordHash,
            role: account.role,
            status: AccountStatus.ACTIVE,
            mustChangePassword: true,
          },
          update: {
            username: account.username,
            passwordHash,
            role: account.role,
            status: AccountStatus.ACTIVE,
            mustChangePassword: true,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
      }

      for (const employee of fixture.employees) {
        await transaction.employee.upsert({
          where: { id: employee.id },
          create: {
            ...employee,
            status: EmployeeStatus.ACTIVE,
            employmentDate: businessDate('2026-01-01'),
          },
          update: {
            ...employee,
            status: EmployeeStatus.ACTIVE,
            employmentDate: businessDate('2026-01-01'),
          },
        });
      }

      const expectedStoreName = 'DEMO - Fixture Store Only';
      const expectedStoreAddress = 'Synthetic local fixture; not a business location.';
      const storeCollisions = await transaction.store.findMany({
        where: { OR: [{ id: ids.store }, { name: expectedStoreName }] },
        select: {
          id: true,
          name: true,
          address: true,
          latitude: true,
          longitude: true,
          radiusMeters: true,
          accuracyLimitMeters: true,
          wifiPublicIp: true,
          isActive: true,
        },
      });
      if (
        storeCollisions.some(
          (store) =>
            store.id !== ids.store ||
            store.name !== expectedStoreName ||
            store.address !== expectedStoreAddress ||
            Number(store.latitude) !== 0 ||
            Number(store.longitude) !== 0 ||
            store.radiusMeters !== 10 ||
            store.accuracyLimitMeters !== 30 ||
            store.wifiPublicIp !== null ||
            !store.isActive,
        )
      ) {
        throw new DemoSeedDataError('Demo store ID/nama bertabrakan dengan record non-demo.');
      }
      await transaction.store.upsert({
        where: { id: ids.store },
        create: {
          id: ids.store,
          name: expectedStoreName,
          address: expectedStoreAddress,
          latitude: '0.000000',
          longitude: '0.000000',
          radiusMeters: 10,
          accuracyLimitMeters: 30,
        },
        update: {
          name: expectedStoreName,
          address: expectedStoreAddress,
          latitude: '0.000000',
          longitude: '0.000000',
          radiusMeters: 10,
          accuracyLimitMeters: 30,
          isActive: true,
        },
      });

      await transaction.employeeStore.upsert({
        where: { employeeId_storeId: { employeeId: ids.employee, storeId: ids.store } },
        create: {
          employeeId: ids.employee,
          storeId: ids.store,
          assignedByUserAccountId: ids.adminOne,
        },
        update: { assignedByUserAccountId: ids.adminOne },
      });

      const expectedShiftName = 'DEMO - Fixture Weekday Shift';
      const expectedWorkDays = [1, 2, 3, 4, 5];
      const shiftCollisions = await transaction.workShift.findMany({
        where: { OR: [{ id: ids.shift }, { name: expectedShiftName }] },
        select: {
          id: true,
          name: true,
          startTime: true,
          endTime: true,
          breakMinutes: true,
          lateToleranceMinutes: true,
          workDays: true,
          isActive: true,
        },
      });
      if (
        shiftCollisions.some(
          (shift) =>
            shift.id !== ids.shift ||
            shift.name !== expectedShiftName ||
            shift.startTime.getTime() !== wallClock('09:00').getTime() ||
            shift.endTime.getTime() !== wallClock('17:00').getTime() ||
            shift.breakMinutes !== 60 ||
            shift.lateToleranceMinutes !== 5 ||
            shift.workDays.length !== expectedWorkDays.length ||
            expectedWorkDays.some((day, index) => shift.workDays[index] !== day) ||
            !shift.isActive,
        )
      ) {
        throw new DemoSeedDataError('Demo shift ID/nama bertabrakan dengan record non-demo.');
      }
      await transaction.workShift.upsert({
        where: { id: ids.shift },
        create: {
          id: ids.shift,
          name: expectedShiftName,
          startTime: wallClock('09:00'),
          endTime: wallClock('17:00'),
          breakMinutes: 60,
          lateToleranceMinutes: 5,
          workDays: [1, 2, 3, 4, 5],
        },
        update: {
          name: expectedShiftName,
          startTime: wallClock('09:00'),
          endTime: wallClock('17:00'),
          breakMinutes: 60,
          lateToleranceMinutes: 5,
          workDays: [1, 2, 3, 4, 5],
          isActive: true,
        },
      });

      const existingAssignment = await transaction.shiftAssignment.findUnique({
        where: { id: ids.shiftAssignment },
        select: { employeeId: true, workShiftId: true, storeId: true },
      });
      if (
        existingAssignment &&
        (existingAssignment.employeeId !== ids.employee ||
          existingAssignment.workShiftId !== ids.shift ||
          existingAssignment.storeId !== ids.store)
      ) {
        throw new DemoSeedDataError('Demo shift assignment ID bertabrakan dengan record non-demo.');
      }
      const employeeAssignments = await transaction.shiftAssignment.findMany({
        where: { employeeId: ids.employee },
        select: { id: true },
      });
      if (employeeAssignments.some((assignment) => assignment.id !== ids.shiftAssignment)) {
        throw new DemoSeedDataError(
          'Demo employee memiliki penugasan shift lain; seed tidak menimpanya.',
        );
      }
      await transaction.shiftAssignment.upsert({
        where: { id: ids.shiftAssignment },
        create: {
          id: ids.shiftAssignment,
          employeeId: ids.employee,
          workShiftId: ids.shift,
          storeId: ids.store,
          assignedByUserAccountId: ids.adminOne,
          effectiveFrom: businessDate('2000-01-01'),
        },
        update: {
          employeeId: ids.employee,
          workShiftId: ids.shift,
          storeId: ids.store,
          assignedByUserAccountId: ids.adminOne,
          effectiveFrom: businessDate('2000-01-01'),
          effectiveTo: null,
        },
      });

      const holidayDate = businessDate('2099-12-31');
      const holidayDescription = 'DEMO ONLY - synthetic fixture holiday';
      const holidayCollisions = await transaction.holiday.findMany({
        where: {
          OR: [{ id: ids.holiday }, { storeId: ids.store, holidayDate }],
        },
        select: { id: true, storeId: true, holidayDate: true, description: true },
      });
      if (
        holidayCollisions.some(
          (holiday) =>
            holiday.id !== ids.holiday ||
            holiday.storeId !== ids.store ||
            holiday.holidayDate.toISOString().slice(0, 10) !== '2099-12-31' ||
            holiday.description !== holidayDescription,
        )
      ) {
        throw new DemoSeedDataError('Demo holiday bertabrakan dengan record non-demo.');
      }
      await transaction.holiday.upsert({
        where: { id: ids.holiday },
        create: {
          id: ids.holiday,
          storeId: ids.store,
          holidayDate,
          description: holidayDescription,
        },
        update: {
          storeId: ids.store,
          holidayDate,
          description: holidayDescription,
        },
      });

      const requestDate = businessDate('2099-01-02');
      const existingRequest = await transaction.attendanceRequest.findUnique({
        where: { id: ids.pendingRequest },
        select: {
          employeeId: true,
          requestType: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
      });
      if (
        existingRequest &&
        (existingRequest.employeeId !== ids.employee ||
          existingRequest.requestType !== RequestType.LEAVE ||
          existingRequest.startDate.toISOString().slice(0, 10) !== '2099-01-02' ||
          existingRequest.endDate.toISOString().slice(0, 10) !== '2099-01-02' ||
          existingRequest.reason !==
            'DEMO ONLY - synthetic pending leave request; not a real request.')
      ) {
        throw new DemoSeedDataError('Demo request ID bertabrakan dengan record non-demo.');
      }
      await transaction.attendanceRequest.upsert({
        where: { id: ids.pendingRequest },
        create: {
          id: ids.pendingRequest,
          employeeId: ids.employee,
          requestType: RequestType.LEAVE,
          startDate: requestDate,
          endDate: requestDate,
          reason: 'DEMO ONLY - synthetic pending leave request; not a real request.',
        },
        update: {
          employeeId: ids.employee,
          requestType: RequestType.LEAVE,
          startDate: requestDate,
          endDate: requestDate,
          reason: 'DEMO ONLY - synthetic pending leave request; not a real request.',
          status: RequestStatus.PENDING,
          attachmentObjectKey: null,
          approverUserAccountId: null,
          decisionAt: null,
          decisionNote: null,
        },
      });
    });

    console.log(
      'Synthetic local demo data seeded: 2 Admin, 1 Supervisor, 1 Employee, 1 store, 1 shift, 1 holiday, 1 pending request.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(safeDemoSeedFailureMessage(error));
  process.exitCode = 1;
});
