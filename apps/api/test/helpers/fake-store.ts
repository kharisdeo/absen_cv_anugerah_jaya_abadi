import { EmployeeStatus } from '../../src/generated/prisma/enums.js';
import type {
  EmployeeStoreAssignmentRecord,
  StoreCreateData,
  StoreRecord,
  StoreRepository,
  StoreUpdateData,
} from '../../src/modules/store/index.js';

export const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
export const EMPLOYEE_ID = 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9';
export const STORE_ID = '00000000-0000-4000-8000-000000000001';
export const REQUEST_ID = '00000000-0000-4000-8000-000000000099';
export const NOW = new Date('2026-10-11T03:15:00.000Z');

const PRISMA_SCHEMA_DEFAULTS_FOR_FAKE = { radiusMeters: 10, accuracyLimitMeters: 30 } as const;

export function makeStore(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    name: 'Toko Utama',
    address: null,
    latitude: -6.2,
    longitude: 106.816666,
    radiusMeters: PRISMA_SCHEMA_DEFAULTS_FOR_FAKE.radiusMeters,
    accuracyLimitMeters: PRISMA_SCHEMA_DEFAULTS_FOR_FAKE.accuracyLimitMeters,
    wifiPublicIp: null,
    isActive: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

export function makeEmployee(overrides: Partial<EmployeeStoreAssignmentRecord['employee']> = {}) {
  return {
    id: EMPLOYEE_ID,
    nik: 'AJ-001',
    fullName: 'Karyawan Satu',
    status: EmployeeStatus.ACTIVE,
    ...overrides,
  };
}

export class FakeStoreRepository implements StoreRepository {
  readonly stores = new Map<string, StoreRecord>();
  readonly employees = new Map([[EMPLOYEE_ID, makeEmployee()]]);
  readonly assignments = new Map<string, EmployeeStoreAssignmentRecord>();
  readonly attendanceHistory: Array<Readonly<{ id: string; storeId: string; latitude: number }>> =
    [];
  createInputs: StoreCreateData[] = [];
  updateInputs: Array<{ id: string; data: StoreUpdateData }> = [];
  hardDeleteCount = 0;

  constructor(
    stores: readonly StoreRecord[] = [makeStore()],
    attendanceHistory: readonly Readonly<{ id: string; storeId: string; latitude: number }>[] = [],
  ) {
    for (const store of stores) this.stores.set(store.id, store);
    this.attendanceHistory.push(...attendanceHistory);
  }

  async list(): Promise<readonly StoreRecord[]> {
    return [...this.stores.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async findById(id: string): Promise<StoreRecord | null> {
    return this.stores.get(id) ?? null;
  }

  async create(data: StoreCreateData): Promise<StoreRecord> {
    this.createInputs.push(data);
    const store = makeStore({
      ...data,
      id: `00000000-0000-4000-8000-${String(this.stores.size + 1).padStart(12, '0')}`,
      name: data.name,
      address: data.address ?? null,
      latitude: data.latitude,
      longitude: data.longitude,
      radiusMeters: data.radiusMeters ?? PRISMA_SCHEMA_DEFAULTS_FOR_FAKE.radiusMeters,
      accuracyLimitMeters:
        data.accuracyLimitMeters ?? PRISMA_SCHEMA_DEFAULTS_FOR_FAKE.accuracyLimitMeters,
      wifiPublicIp: data.wifiPublicIp ?? null,
      isActive: data.isActive ?? true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    this.stores.set(store.id, store);
    return store;
  }

  async update(id: string, data: StoreUpdateData): Promise<StoreRecord | null> {
    this.updateInputs.push({ id, data });
    const before = this.stores.get(id);
    if (!before) return null;
    const updated = makeStore({ ...before, ...data, updatedAt: new Date(NOW.getTime() + 1) });
    this.stores.set(id, updated);
    return updated;
  }

  async findEmployeeById(id: string): Promise<EmployeeStoreAssignmentRecord['employee'] | null> {
    return this.employees.get(id) ?? null;
  }

  async listAssignments(storeId: string): Promise<readonly EmployeeStoreAssignmentRecord[]> {
    return [...this.assignments.values()].filter((row) => row.storeId === storeId);
  }

  async findAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<EmployeeStoreAssignmentRecord | null> {
    return this.assignments.get(`${storeId}:${employeeId}`) ?? null;
  }

  async createAssignment(
    input: Readonly<{
      storeId: string;
      employeeId: string;
      assignedByUserAccountId: string;
    }>,
  ): Promise<Readonly<{ assignment: EmployeeStoreAssignmentRecord; created: boolean }>> {
    const key = `${input.storeId}:${input.employeeId}`;
    const existing = this.assignments.get(key);
    if (existing) return { assignment: existing, created: false };
    const employee = this.employees.get(input.employeeId);
    if (!employee || !this.stores.has(input.storeId)) throw new Error('fake foreign key violation');
    const assignment = {
      ...input,
      assignedAt: new Date(NOW),
      employee,
    };
    this.assignments.set(key, assignment);
    return { assignment, created: true };
  }

  async deleteAssignment(
    storeId: string,
    employeeId: string,
  ): Promise<Readonly<{ removed: boolean; before: EmployeeStoreAssignmentRecord | null }>> {
    const key = `${storeId}:${employeeId}`;
    const before = this.assignments.get(key) ?? null;
    if (!before) return { removed: false, before: null };
    this.assignments.delete(key);
    return { removed: true, before };
  }
}
