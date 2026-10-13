import { describe, expect, it } from 'vitest';

import { EmployeeStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditActor, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import { StoreService } from '../../src/modules/store/index.js';
import {
  ADMIN_ID,
  EMPLOYEE_ID,
  FakeStoreRepository,
  REQUEST_ID,
  STORE_ID,
  makeEmployee,
  makeStore,
} from '../helpers/fake-store.js';

const admin: AuditActor = { userAccountId: ADMIN_ID, role: UserRole.ADMIN };
const employeeActor: AuditActor = {
  userAccountId: 'b7fd4072-f499-4cd4-959a-730f9f037801',
  role: UserRole.EMPLOYEE,
  employeeId: EMPLOYEE_ID,
};

function harness(stores = [makeStore()]) {
  const repository = new FakeStoreRepository(stores);
  const events: RecordAuditEventInput[] = [];
  const service = new StoreService(repository, {
    async record(event) {
      events.push(event);
      return {} as never;
    },
  });
  return { repository, events, service };
}

describe('StoreService', () => {
  it('is Admin-only and rejects invalid UUIDs before repository access', async () => {
    const { service } = harness();
    await expect(service.list(employeeActor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.get(admin, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.listAssignments(admin, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('accepts inclusive physical and storage precision boundaries and uses schema defaults', async () => {
    const { repository, service } = harness([]);
    const store = await service.create(admin, {
      name: '  Toko Batas  ',
      latitude: -90,
      longitude: 180,
    });
    expect(store).toMatchObject({
      name: 'Toko Batas',
      latitude: -90,
      longitude: 180,
      radiusMeters: 10,
      accuracyLimitMeters: 30,
      address: null,
      wifiPublicIp: null,
      isActive: true,
    });
    expect(repository.createInputs[0]).not.toHaveProperty('radiusMeters');
    expect(repository.createInputs[0]).not.toHaveProperty('accuracyLimitMeters');
  });

  it('accepts six decimal places and both IPv4 and IPv6; null clears optional fields', async () => {
    const { service } = harness();
    const ipv4 = await service.update(admin, STORE_ID, {
      latitude: 90,
      longitude: -180,
      wifiPublicIp: '203.0.113.10',
      address: 'Alamat toko',
    });
    expect(ipv4).toMatchObject({ latitude: 90, longitude: -180, wifiPublicIp: '203.0.113.10' });
    const ipv6 = await service.update(admin, STORE_ID, { wifiPublicIp: '2001:db8::1' });
    expect(ipv6.wifiPublicIp).toBe('2001:db8::1');
    const cleared = await service.update(admin, STORE_ID, { wifiPublicIp: null, address: null });
    expect(cleared).toMatchObject({ wifiPublicIp: null, address: null });
  });

  it('rejects non-finite, out-of-range, and over-precision coordinates and non-positive/non-int radius values', async () => {
    const { service } = harness();
    const invalidCoordinatePairs: ReadonlyArray<readonly [number, number]> = [
      [90.000001, 0],
      [-90.000001, 0],
      [Number.NaN, 0],
      [0, 180.000001],
      [0, -180.000001],
      [0, 1.1234567],
    ];
    for (const [latitude, longitude] of invalidCoordinatePairs) {
      await expect(
        service.create(admin, { name: 'Toko', latitude, longitude }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_STORE_INPUT',
      });
    }
    for (const radiusMeters of [0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY]) {
      await expect(
        service.create(admin, { name: 'Toko', latitude: 0, longitude: 0, radiusMeters }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(
      service.create(admin, {
        name: 'Toko',
        latitude: 0,
        longitude: 0,
        accuracyLimitMeters: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects invalid Wi-Fi IP values and non-boolean status', async () => {
    const { service } = harness();
    for (const wifiPublicIp of ['not-an-ip', '192.0.2.1/24', 'fe80::1%en0', '  ']) {
      await expect(
        service.create(admin, { name: 'Toko', latitude: 0, longitude: 0, wifiPublicIp }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(
      service.update(admin, STORE_ID, { isActive: 'false' as never }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('allows duplicate store names because the schema does not declare names unique', async () => {
    const { service, repository } = harness([]);
    await service.create(admin, { name: 'Nama Sama', latitude: 1, longitude: 2 });
    await service.create(admin, { name: 'Nama Sama', latitude: 3, longitude: 4 });
    expect(repository.stores.size).toBe(2);
  });

  it('audits create/update with before-after and request context, but not an unchanged update', async () => {
    const { events, service } = harness();
    const context = { clientIp: '203.0.113.5', requestId: REQUEST_ID };
    await service.create(admin, { name: 'Baru', latitude: -6.2, longitude: 106.8 }, context);
    await service.update(admin, STORE_ID, { radiusMeters: 25 }, context);
    await service.update(admin, STORE_ID, { radiusMeters: 25 }, context);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'store.create',
      entityType: 'store',
      after: { name: 'Baru', radiusMeters: 10, accuracyLimitMeters: 30 },
      clientIp: context.clientIp,
      requestId: REQUEST_ID,
    });
    expect(events[1]).toMatchObject({
      action: 'store.update',
      before: { radiusMeters: 10 },
      after: { radiusMeters: 25 },
      clientIp: context.clientIp,
      requestId: REQUEST_ID,
    });
  });

  it('soft-deactivates without deleting the store and avoids duplicate no-op audit', async () => {
    const { events, repository, service } = harness();
    const first = await service.deactivate(admin, STORE_ID, { requestId: REQUEST_ID });
    const second = await service.deactivate(admin, STORE_ID, { requestId: REQUEST_ID });
    expect(first.isActive).toBe(false);
    expect(second.isActive).toBe(false);
    expect(repository.stores.has(STORE_ID)).toBe(true);
    expect(repository.hardDeleteCount).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'store.deactivate',
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  it('requires existing store and employee IDs for assignment operations', async () => {
    const { service } = harness();
    const missingStore = '00000000-0000-4000-8000-000000000777';
    const missingEmployee = '00000000-0000-4000-8000-000000000778';
    await expect(service.listAssignments(admin, missingStore)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.assignEmployee(admin, missingStore, EMPLOYEE_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.assignEmployee(admin, STORE_ID, missingEmployee)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.removeEmployee(admin, STORE_ID, missingEmployee)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('assigns idempotently, lists assignments, and audits only the first assignment', async () => {
    const { events, service } = harness();
    const context = { clientIp: '127.0.0.1', requestId: REQUEST_ID };
    const first = await service.assignEmployee(admin, STORE_ID, EMPLOYEE_ID, context);
    const repeated = await service.assignEmployee(admin, STORE_ID, EMPLOYEE_ID, context);
    const listed = await service.listAssignments(admin, STORE_ID);
    expect(first).toMatchObject({
      storeId: STORE_ID,
      employeeId: EMPLOYEE_ID,
      employee: makeEmployee(),
    });
    expect(repeated.assignedAt).toBe(first.assignedAt);
    expect(listed).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'store.employee_assigned',
      entityType: 'employee_store',
      after: { storeId: STORE_ID, employeeId: EMPLOYEE_ID },
      clientIp: context.clientIp,
      requestId: REQUEST_ID,
    });
  });

  it('removes assignments idempotently, audits only actual removal, and leaves attendance history untouched', async () => {
    const repository = new FakeStoreRepository(
      [makeStore()],
      [{ id: 'attendance-original', storeId: STORE_ID, latitude: -6.2 }],
    );
    const events: RecordAuditEventInput[] = [];
    const service = new StoreService(repository, {
      async record(event) {
        events.push(event);
        return {} as never;
      },
    });
    await service.assignEmployee(admin, STORE_ID, EMPLOYEE_ID);
    await service.update(admin, STORE_ID, { latitude: -6.3, radiusMeters: 50 });
    await service.removeEmployee(admin, STORE_ID, EMPLOYEE_ID, { requestId: REQUEST_ID });
    await service.removeEmployee(admin, STORE_ID, EMPLOYEE_ID, { requestId: REQUEST_ID });

    expect(repository.assignments.size).toBe(0);
    expect(repository.attendanceHistory).toEqual([
      { id: 'attendance-original', storeId: STORE_ID, latitude: -6.2 },
    ]);
    expect(events.map((event) => event.action)).toEqual([
      'store.employee_assigned',
      'store.update',
      'store.employee_unassigned',
    ]);
    expect(events[2]).toMatchObject({
      before: { storeId: STORE_ID, employeeId: EMPLOYEE_ID },
      requestId: REQUEST_ID,
    });
  });

  it('does not filter inactive employee/store assignments by inventing an active-only policy', async () => {
    const inactiveEmployee = makeEmployee({ status: EmployeeStatus.INACTIVE });
    const inactiveStore = makeStore({ isActive: false });
    const { repository, service } = harness([inactiveStore]);
    repository.employees.set(inactiveEmployee.id, inactiveEmployee);
    const assignment = await service.assignEmployee(admin, inactiveStore.id, inactiveEmployee.id);
    expect(assignment.employee.status).toBe(EmployeeStatus.INACTIVE);
  });

  it('returns 404 for missing store detail', async () => {
    const { service } = harness([]);
    await expect(service.get(admin, STORE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'STORE_NOT_FOUND',
    });
  });
});
