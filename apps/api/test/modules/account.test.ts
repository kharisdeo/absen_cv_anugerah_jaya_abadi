import { describe, expect, it } from 'vitest';

import { AccountStatus, EmployeeStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type {
  AuditActor,
  AuditService,
  RecordAuditEventInput,
} from '../../src/modules/audit/index.js';
import {
  AccountService,
  type AccountCreateData,
  type AccountDto,
  type AccountEmployeeLink,
  type AccountMutation,
  type AccountRepository,
  type AccountUpdateData,
} from '../../src/modules/account/index.js';
import {
  ACCOUNT_IDENTIFIER_LOCK_KEY,
  PrismaAccountRepository,
} from '../../src/modules/account/prisma-repository.js';
import { PrismaEmployeeRepository } from '../../src/modules/employee/prisma-repository.js';
import type { EmployeeCreateData } from '../../src/modules/employee/index.js';

const ADMIN_ONE = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const ADMIN_TWO = 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9';
const ADMIN_THREE = '8f9a9fcb-5463-48dc-bc97-2cd2c6f61a2d';
const ACCOUNT_ID = 'f6465af6-9fb2-46e7-832f-a835c0644d69';
const CREATED_ACCOUNT_ID = 'a5c4bd42-8a86-462a-9ec0-ecc213fbf128';
const EMPLOYEE_ID = 'd207ceef-38dc-4ad8-901f-65b642184acf';
const OTHER_EMPLOYEE_ID = '2bf3159c-ece8-47f8-8a1f-e75f07da4709';
const NOW = new Date('2026-10-11T03:15:00.000Z');
const TEMPORARY_PASSWORD = 'temporary-password-for-test';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$test$safe-fake-hash';

const admin: AuditActor = { role: UserRole.ADMIN, userAccountId: ADMIN_ONE };
const employeeActor: AuditActor = {
  role: UserRole.EMPLOYEE,
  employeeId: EMPLOYEE_ID,
  userAccountId: ACCOUNT_ID,
};

function makeAccount(overrides: Partial<AccountDto> = {}): AccountDto {
  return {
    id: ACCOUNT_ID,
    username: 'user-one',
    role: UserRole.EMPLOYEE,
    status: AccountStatus.ACTIVE,
    employeeId: null,
    mustChangePassword: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEmployeeLink(
  id = EMPLOYEE_ID,
  nik = 'NIK-001',
  accountId: string | null = null,
): AccountEmployeeLink {
  return { id, nik, accountId };
}

class FakeAccountRepository implements AccountRepository {
  readonly rows = new Map<string, AccountDto>();
  readonly employees = new Map<string, AccountEmployeeLink>();
  readonly persistedHashes: string[] = [];
  readonly revokedAccountSessions: string[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();
  private createdAccountNumber = 0;

  constructor(
    accounts: readonly AccountDto[] = [],
    employees: readonly AccountEmployeeLink[] = [],
  ) {
    for (const account of accounts) this.rows.set(account.id, account);
    for (const employee of employees) this.employees.set(employee.id, employee);
  }

  async list(): Promise<readonly AccountDto[]> {
    return [...this.rows.values()];
  }

  async findById(id: string): Promise<AccountDto | null> {
    return this.rows.get(id) ?? null;
  }

  async findByUsername(username: string): Promise<AccountDto | null> {
    return [...this.rows.values()].find((account) => account.username === username) ?? null;
  }

  async findEmployeeByNik(nik: string): Promise<AccountEmployeeLink | null> {
    return [...this.employees.values()].find((employee) => employee.nik === nik) ?? null;
  }

  async findEmployeeById(id: string): Promise<AccountEmployeeLink | null> {
    return this.employees.get(id) ?? null;
  }

  async create(data: AccountCreateData): Promise<AccountDto> {
    if ([...this.rows.values()].some((account) => account.username === data.username)) {
      throw new Error('Unique username conflict');
    }
    if (data.employeeId) {
      const employee = this.employees.get(data.employeeId);
      if (!employee) throw new Error('Missing employee');
      if (employee.accountId) throw new Error('Employee already linked');
    }
    this.createdAccountNumber += 1;
    const id = this.createdAccountNumber === 1 ? CREATED_ACCOUNT_ID : ADMIN_THREE;
    const account = makeAccount({
      id,
      username: data.username,
      role: data.role,
      status: data.status,
      employeeId: data.employeeId,
      mustChangePassword: true,
      createdAt: new Date(NOW.getTime() + 1),
      updatedAt: new Date(NOW.getTime() + 1),
    });
    this.rows.set(id, account);
    this.persistedHashes.push(data.passwordHash);
    if (data.employeeId) {
      const employee = this.employees.get(data.employeeId);
      if (employee) this.employees.set(employee.id, { ...employee, accountId: id });
    }
    return account;
  }

  updateWithAdminFloor(id: string, data: AccountUpdateData): Promise<AccountMutation | null> {
    return this.mutate(id, data, false);
  }

  deactivateWithAdminFloor(id: string): Promise<AccountMutation | null> {
    return this.mutate(id, { status: AccountStatus.INACTIVE }, true);
  }

  private async mutate(
    id: string,
    data: AccountUpdateData,
    forceSessionRevocation: boolean,
  ): Promise<AccountMutation | null> {
    let release!: () => void;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const before = this.rows.get(id);
      if (!before) return null;

      const nextRole = data.role ?? before.role;
      const nextStatus = data.status ?? before.status;
      const removesActiveAdmin =
        before.role === UserRole.ADMIN &&
        before.status === AccountStatus.ACTIVE &&
        (nextRole !== UserRole.ADMIN || nextStatus !== AccountStatus.ACTIVE);
      if (removesActiveAdmin) {
        const activeAdmins = [...this.rows.values()].filter(
          (account) => account.role === UserRole.ADMIN && account.status === AccountStatus.ACTIVE,
        ).length;
        if (activeAdmins <= 2) {
          throw Object.assign(new Error('Active Admin floor'), {
            statusCode: 409,
            code: 'ACTIVE_ADMIN_FLOOR',
          });
        }
      }

      const changed =
        (data.username !== undefined && data.username !== before.username) ||
        (data.role !== undefined && data.role !== before.role) ||
        (data.status !== undefined && data.status !== before.status) ||
        (data.employeeId !== undefined && data.employeeId !== before.employeeId);
      let after = before;
      if (changed) {
        const updatedAt = new Date(before.updatedAt.getTime() + 1);
        after = { ...before, ...data, updatedAt };
        this.rows.set(id, after);
        if (data.employeeId !== undefined && data.employeeId !== before.employeeId) {
          if (before.employeeId) {
            const oldEmployee = this.employees.get(before.employeeId);
            if (oldEmployee)
              this.employees.set(oldEmployee.id, { ...oldEmployee, accountId: null });
          }
          if (data.employeeId) {
            const nextEmployee = this.employees.get(data.employeeId);
            if (nextEmployee) {
              this.employees.set(nextEmployee.id, { ...nextEmployee, accountId: id });
            }
          }
        }
      }
      if (forceSessionRevocation || before.role !== nextRole || before.status !== nextStatus) {
        this.revokedAccountSessions.push(id);
      }
      return { before, after, changed };
    } finally {
      release();
    }
  }
}

function makeHarness(
  options: {
    accounts?: readonly AccountDto[];
    employees?: readonly AccountEmployeeLink[];
    createTemporaryPassword?: () => string;
  } = {},
) {
  const repository = new FakeAccountRepository(options.accounts, options.employees);
  const events: RecordAuditEventInput[] = [];
  const hashInputs: string[] = [];
  const audit = {
    async record(event: RecordAuditEventInput) {
      events.push(event);
      return {} as Awaited<ReturnType<AuditService['record']>>;
    },
  };
  const passwordHasher = {
    async hash(password: string) {
      hashInputs.push(password);
      return PASSWORD_HASH;
    },
  };
  const service = new AccountService({
    repository,
    audit,
    passwordHasher,
    ...(options.createTemporaryPassword
      ? { createTemporaryPassword: options.createTemporaryPassword }
      : {}),
  });
  return { service, repository, events, hashInputs };
}

function makeLockingPrismaState(
  seed: {
    account?: AccountDto;
    employee?: AccountEmployeeLink & {
      fullName: string;
      position: string | null;
      status: EmployeeStatus;
      employmentDate: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
  } = {},
) {
  const accounts = new Map<string, AccountDto>();
  const employees = new Map<string, NonNullable<typeof seed.employee>>();
  if (seed.account) accounts.set(seed.account.id, seed.account);
  if (seed.employee) employees.set(seed.employee.id, seed.employee);
  const lockKeys: unknown[] = [];
  let lockQueue: Promise<void> = Promise.resolve();

  function accountRow(account: AccountDto) {
    return { ...account, employee: account.employeeId ? { id: account.employeeId } : null };
  }

  function acquireLock(): Promise<() => void> {
    let release!: () => void;
    const previous = lockQueue;
    lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => release);
  }

  const prisma = {
    async $transaction(callback: (tx: Record<string, unknown>) => Promise<unknown>) {
      let release: (() => void) | undefined;
      const tx = {
        async $queryRaw(query: unknown) {
          if (!release) {
            const values = (query as { values?: unknown[] }).values;
            lockKeys.push(values?.[0]);
            release = await acquireLock();
          }
          return [];
        },
        userAccount: {
          async findUnique({ where }: { where: { id?: string; username?: string } }) {
            const account = where.id
              ? accounts.get(where.id)
              : [...accounts.values()].find((row) => row.username === where.username);
            return account ? accountRow(account) : null;
          },
          async create({ data }: { data: AccountCreateData }) {
            const account = makeAccount({
              id: CREATED_ACCOUNT_ID,
              username: data.username,
              role: data.role,
              status: data.status,
              employeeId: data.employeeId,
              mustChangePassword: true,
            });
            accounts.set(account.id, account);
            return accountRow(account);
          },
          async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
            const account = accounts.get(where.id);
            if (!account) throw new Error('Account not found');
            const updated = makeAccount({ ...account, ...(data as Partial<AccountDto>) });
            accounts.set(updated.id, updated);
            return accountRow(updated);
          },
          async count() {
            return [...accounts.values()].filter(
              (account) =>
                account.role === UserRole.ADMIN && account.status === AccountStatus.ACTIVE,
            ).length;
          },
        },
        employee: {
          async findUnique({ where }: { where: { id?: string; nik?: string } }) {
            const employee = where.id
              ? employees.get(where.id)
              : [...employees.values()].find((row) => row.nik === where.nik);
            return employee ?? null;
          },
          async create({ data }: { data: EmployeeCreateData }) {
            const employee = {
              id: OTHER_EMPLOYEE_ID,
              ...data,
              createdAt: NOW,
              updatedAt: NOW,
              accountId: null,
            };
            employees.set(employee.id, employee);
            return employee;
          },
          async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
            const employee = employees.get(where.id);
            if (!employee) throw new Error('Employee not found');
            const updated = { ...employee, ...data };
            employees.set(updated.id, updated);
            return updated;
          },
        },
        session: {
          async updateMany() {
            return { count: 0 };
          },
        },
      };
      try {
        return await callback(tx);
      } finally {
        release?.();
      }
    },
  } as unknown as PrismaClient;

  return { prisma, accounts, employees, lockKeys };
}

describe('AccountService', () => {
  it('allows only Admins and validates identifiers, username, role, status, and employee links', async () => {
    const { service, repository } = makeHarness({ employees: [makeEmployeeLink()] });
    await expect(service.list(employeeActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.create(employeeActor, { username: 'x', role: UserRole.EMPLOYEE }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.get(admin, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_ACCOUNT_INPUT',
    });
    await expect(
      service.create(admin, { username: '  ', role: UserRole.EMPLOYEE }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      service.create(admin, { username: 'new-user', role: 'INVALID' as UserRole }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.create(admin, {
        username: 'new-user',
        role: UserRole.EMPLOYEE,
        employeeId: 'not-a-uuid',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.create(admin, {
        username: 'new-user',
        role: UserRole.EMPLOYEE,
        employeeId: OTHER_EMPLOYEE_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.rows.size).toBe(0);
  });

  it('trims exact-case usernames and rejects collisions with accounts or any employee NIK', async () => {
    const existing = makeAccount({ username: 'Existing' });
    const { service, repository } = makeHarness({
      accounts: [existing],
      employees: [makeEmployeeLink(EMPLOYEE_ID, 'NIK-001')],
      createTemporaryPassword: () => TEMPORARY_PASSWORD,
    });
    await expect(
      service.create(admin, { username: '  Existing  ', role: UserRole.EMPLOYEE }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_USERNAME_CONFLICT', statusCode: 409 });
    await expect(
      service.create(admin, { username: ' NIK-001 ', role: UserRole.EMPLOYEE }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_USERNAME_CONFLICT', statusCode: 409 });

    const created = await service.create(admin, {
      username: ' existing ',
      role: UserRole.EMPLOYEE,
      status: AccountStatus.ACTIVE,
    });
    expect(created.account.username).toBe('existing');
    expect(repository.rows.get(created.account.id)?.username).toBe('existing');
  });

  it('hashes an injected temporary secret, returns it once, and audits only safe data and context', async () => {
    const { service, repository, events, hashInputs } = makeHarness({
      createTemporaryPassword: () => TEMPORARY_PASSWORD,
    });
    const result = await service.create(
      admin,
      { username: '  new-user  ', role: UserRole.SUPERVISOR },
      { clientIp: '192.0.2.10', requestId: 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9' },
    );

    expect(hashInputs).toEqual([TEMPORARY_PASSWORD]);
    expect(repository.persistedHashes).toEqual([PASSWORD_HASH]);
    expect(result.temporaryPassword).toBe(TEMPORARY_PASSWORD);
    expect(result.account).toMatchObject({
      username: 'new-user',
      role: UserRole.SUPERVISOR,
      status: AccountStatus.ACTIVE,
      mustChangePassword: true,
    });
    expect(Object.keys(result.account).sort()).toEqual(
      [
        'id',
        'username',
        'role',
        'status',
        'employeeId',
        'mustChangePassword',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'account.create',
      entityType: 'UserAccount',
      after: { username: 'new-user', role: UserRole.SUPERVISOR },
      clientIp: '192.0.2.10',
      requestId: 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9',
    });
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain(TEMPORARY_PASSWORD);
    expect(auditJson).not.toContain(PASSWORD_HASH);
    expect(auditJson).not.toContain('failedLoginAttempts');
    expect(auditJson).not.toContain('session');
    expect(JSON.stringify(result.account)).not.toContain('passwordHash');
  });

  it('generates a 24-byte base64url initial password accepted by AuthService password validation', async () => {
    const { service, hashInputs } = makeHarness();
    const created = await service.create(admin, {
      username: 'generated-user',
      role: UserRole.EMPLOYEE,
    });
    const generated = created.temporaryPassword;

    // AuthService accepts nonempty values up to 1,024 characters and 4,096 UTF-8 bytes.
    expect(generated).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.byteLength(generated, 'utf8')).toBe(32);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(generated, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(hashInputs).toEqual([generated]);
  });

  it('revokes sessions for role or status changes and soft-deactivates accounts', async () => {
    const target = makeAccount({ role: UserRole.SUPERVISOR });
    const { service, repository, events } = makeHarness({ accounts: [target] });

    const suspended = await service.update(admin, target.id, { status: AccountStatus.SUSPENDED });
    expect(suspended.status).toBe(AccountStatus.SUSPENDED);
    expect(repository.revokedAccountSessions).toEqual([target.id]);

    const deactivated = await service.deactivate(admin, target.id);
    expect(deactivated.status).toBe(AccountStatus.INACTIVE);
    expect(repository.rows.has(target.id)).toBe(true);
    expect(repository.revokedAccountSessions).toEqual([target.id, target.id]);
    expect(events.map((event) => event.action)).toEqual(['account.update', 'account.deactivate']);
    expect(events[1]).toMatchObject({
      before: { status: AccountStatus.SUSPENDED },
      after: { status: AccountStatus.INACTIVE },
    });
  });

  it('audits a role change as a permission change with before and after snapshots', async () => {
    const target = makeAccount({ role: UserRole.SUPERVISOR });
    const { service, events } = makeHarness({ accounts: [target] });
    const context = { clientIp: '192.0.2.10', requestId: 'bbdd38cb-337d-4f0a-ab83-7fe029c0f5b9' };

    const updated = await service.update(admin, target.id, { role: UserRole.ADMIN }, context);

    expect(updated.role).toBe(UserRole.ADMIN);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: admin,
      action: 'account.update',
      entityType: 'UserAccount',
      entityId: target.id,
      before: { role: UserRole.SUPERVISOR },
      after: { role: UserRole.ADMIN },
      clientIp: context.clientIp,
      requestId: context.requestId,
    });
  });

  it('serializes concurrent fake mutations so the active Admin floor cannot be crossed', async () => {
    const admins = [ADMIN_ONE, ADMIN_TWO, ADMIN_THREE].map((id, index) =>
      makeAccount({
        id,
        username: `admin-${index + 1}`,
        role: UserRole.ADMIN,
        employeeId: null,
      }),
    );
    const { service, repository, events } = makeHarness({ accounts: admins });

    const results = await Promise.allSettled([
      service.deactivate(admin, ADMIN_TWO),
      service.deactivate(admin, ADMIN_THREE),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      reason: { statusCode: 409, code: 'ACTIVE_ADMIN_FLOOR' },
    });
    expect(
      [...repository.rows.values()].filter(
        (account) => account.role === UserRole.ADMIN && account.status === AccountStatus.ACTIVE,
      ),
    ).toHaveLength(2);
    expect(repository.rows.size).toBe(3);
    expect(repository.revokedAccountSessions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

describe('Prisma account and employee identifier writes', () => {
  it.each(['create', 'update'] as const)(
    'serializes concurrent account username and employee NIK %s writes and rechecks under the shared lock',
    async (operation) => {
      const initialAccount = makeAccount({ username: 'account-old' });
      const initialEmployee = {
        ...makeEmployeeLink(EMPLOYEE_ID, 'NIK-OLD'),
        fullName: 'Employee One',
        position: null,
        status: EmployeeStatus.ACTIVE,
        employmentDate: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const state = makeLockingPrismaState(
        operation === 'create' ? {} : { account: initialAccount, employee: initialEmployee },
      );
      const accountRepository = new PrismaAccountRepository(state.prisma);
      const employeeRepository = new PrismaEmployeeRepository(state.prisma);

      const writes =
        operation === 'create'
          ? [
              accountRepository.create({
                username: 'CROSS-ID',
                passwordHash: PASSWORD_HASH,
                role: UserRole.EMPLOYEE,
                status: AccountStatus.ACTIVE,
                employeeId: null,
              }),
              employeeRepository.create({
                nik: 'CROSS-ID',
                fullName: 'Employee Two',
                position: null,
                status: EmployeeStatus.ACTIVE,
                employmentDate: null,
              }),
            ]
          : [
              accountRepository.updateWithAdminFloor(initialAccount.id, { username: 'CROSS-ID' }),
              employeeRepository.update(EMPLOYEE_ID, { nik: 'CROSS-ID' }),
            ];
      const results = await Promise.allSettled(writes);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(state.lockKeys).toEqual([ACCOUNT_IDENTIFIER_LOCK_KEY, ACCOUNT_IDENTIFIER_LOCK_KEY]);
      const accountUsesIdentifier = [...state.accounts.values()].some(
        (account) => account.username === 'CROSS-ID',
      );
      const employeeUsesIdentifier = [...state.employees.values()].some(
        (employee) => employee.nik === 'CROSS-ID',
      );
      expect(Number(accountUsesIdentifier) + Number(employeeUsesIdentifier)).toBe(1);
    },
  );
});
