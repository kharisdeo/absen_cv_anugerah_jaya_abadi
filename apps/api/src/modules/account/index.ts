import { randomBytes } from 'node:crypto';

import { AccountStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';
import type { PasswordHasher } from '../auth/contracts.js';

export type AccountDto = Readonly<{
  id: string;
  username: string;
  role: UserRole;
  status: AccountStatus;
  employeeId: string | null;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AccountEmployeeLink = Readonly<{
  id: string;
  nik: string;
  accountId: string | null;
}>;

export type AccountCreateData = Readonly<{
  username: string;
  passwordHash: string;
  role: UserRole;
  status: AccountStatus;
  employeeId: string | null;
}>;

export type AccountUpdateData = Readonly<{
  username?: string;
  role?: UserRole;
  status?: AccountStatus;
  employeeId?: string | null;
}>;

export type AccountMutation = Readonly<{
  before: AccountDto;
  after: AccountDto;
  changed: boolean;
}>;

export interface AccountRepository {
  list(): Promise<readonly AccountDto[]>;
  findById(id: string): Promise<AccountDto | null>;
  findByUsername(username: string): Promise<AccountDto | null>;
  findEmployeeByNik(nik: string): Promise<AccountEmployeeLink | null>;
  findEmployeeById(id: string): Promise<AccountEmployeeLink | null>;
  create(data: AccountCreateData): Promise<AccountDto>;
  updateWithAdminFloor(id: string, data: AccountUpdateData): Promise<AccountMutation | null>;
  deactivateWithAdminFloor(id: string): Promise<AccountMutation | null>;
}

export type AccountRequestContext = Readonly<{
  clientIp?: string;
  requestId?: string;
}>;

export type CreateAccountInput = Readonly<{
  username: string;
  role: UserRole;
  status?: AccountStatus;
  employeeId?: string | null;
}>;

export type UpdateAccountInput = Readonly<{
  username?: string;
  role?: UserRole;
  status?: AccountStatus;
  employeeId?: string | null;
}>;

export type CreatedAccount = Readonly<{
  account: AccountDto;
  temporaryPassword: string;
}>;

export interface AccountServiceOptions {
  repository: AccountRepository;
  audit: Pick<AuditService, 'record'>;
  /** Supply the same Argon2id-configured hasher used by authentication. */
  passwordHasher: Pick<PasswordHasher, 'hash'>;
  createTemporaryPassword?: () => string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_PASSWORD_BYTES = 4_096;

function invalidInput(message = 'Data akun tidak valid.'): AppError {
  return new AppError(400, 'INVALID_ACCOUNT_INPUT', message);
}

function notFound(): AppError {
  return new AppError(404, 'ACCOUNT_NOT_FOUND', 'Akun tidak ditemukan.');
}

function usernameConflict(): AppError {
  return new AppError(
    409,
    'ACCOUNT_USERNAME_CONFLICT',
    'Username sudah digunakan oleh akun atau NIK karyawan.',
  );
}

function employeeLinkConflict(): AppError {
  return new AppError(
    409,
    'ACCOUNT_EMPLOYEE_LINK_CONFLICT',
    'Karyawan sudah terhubung ke akun lain.',
  );
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola akun.');
  }
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return value;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('Username wajib berupa teks.');
  const username = value.trim();
  if (
    username.length === 0 ||
    username.length > MAX_USERNAME_LENGTH ||
    [...username].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw invalidInput('Username tidak valid.');
  }
  return username;
}

function normalizeRole(value: unknown): UserRole {
  if (typeof value !== 'string' || !Object.values(UserRole).includes(value as UserRole)) {
    throw invalidInput('Role akun tidak valid.');
  }
  return value as UserRole;
}

function normalizeStatus(value: unknown): AccountStatus {
  if (typeof value !== 'string' || !Object.values(AccountStatus).includes(value as AccountStatus)) {
    throw invalidInput('Status akun tidak valid.');
  }
  return value as AccountStatus;
}

function normalizeEmployeeId(value: unknown): string | null {
  if (value === null) return null;
  return normalizeId(value, 'ID karyawan');
}

function safeDto(account: AccountDto): AccountDto {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    status: account.status,
    employeeId: account.employeeId,
    mustChangePassword: account.mustChangePassword,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function snapshot(account: AccountDto): Record<string, unknown> {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    status: account.status,
    employeeId: account.employeeId,
    mustChangePassword: account.mustChangePassword,
  };
}

function auditContext(context: AccountRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

export class AccountService {
  private readonly createTemporaryPassword: () => string;

  constructor(private readonly options: AccountServiceOptions) {
    this.createTemporaryPassword =
      options.createTemporaryPassword ?? (() => randomBytes(24).toString('base64url'));
  }

  async list(actor: AuditActor): Promise<readonly AccountDto[]> {
    assertAdmin(actor);
    return (await this.options.repository.list()).map(safeDto);
  }

  async get(actor: AuditActor, accountId: string): Promise<AccountDto> {
    assertAdmin(actor);
    const account = await this.options.repository.findById(normalizeId(accountId, 'ID akun'));
    if (!account) throw notFound();
    return safeDto(account);
  }

  async create(
    actor: AuditActor,
    input: CreateAccountInput,
    context: AccountRequestContext = {},
  ): Promise<CreatedAccount> {
    assertAdmin(actor);
    const username = normalizeUsername(input.username);
    const role = normalizeRole(input.role);
    const status =
      input.status === undefined ? AccountStatus.ACTIVE : normalizeStatus(input.status);
    const employeeId =
      input.employeeId === undefined ? null : normalizeEmployeeId(input.employeeId);

    await this.assertUsernameAvailable(username);
    await this.assertEmployeeLinkAvailable(employeeId, null);

    const temporaryPassword = this.createTemporaryPassword();
    this.assertAuthPasswordPolicy(temporaryPassword);
    const passwordHash = await this.options.passwordHasher.hash(temporaryPassword);
    const account = safeDto(
      await this.options.repository.create({ username, passwordHash, role, status, employeeId }),
    );

    await this.options.audit.record({
      actor,
      action: 'account.create',
      entityType: 'UserAccount',
      entityId: account.id,
      after: snapshot(account),
      ...auditContext(context),
    });
    return { account, temporaryPassword };
  }

  async update(
    actor: AuditActor,
    accountId: string,
    input: UpdateAccountInput,
    context: AccountRequestContext = {},
  ): Promise<AccountDto> {
    assertAdmin(actor);
    const id = normalizeId(accountId, 'ID akun');
    const before = await this.options.repository.findById(id);
    if (!before) throw notFound();

    const data: {
      username?: string;
      role?: UserRole;
      status?: AccountStatus;
      employeeId?: string | null;
    } = {};
    if (input.username !== undefined) data.username = normalizeUsername(input.username);
    if (input.role !== undefined) data.role = normalizeRole(input.role);
    if (input.status !== undefined) data.status = normalizeStatus(input.status);
    if (input.employeeId !== undefined) data.employeeId = normalizeEmployeeId(input.employeeId);
    if (Object.keys(data).length === 0) throw invalidInput('Tidak ada data akun yang diperbarui.');

    if (data.username !== undefined || (data.employeeId && data.employeeId !== before.employeeId)) {
      await this.assertUsernameAvailable(data.username ?? before.username, id);
    }
    if (data.employeeId !== undefined) await this.assertEmployeeLinkAvailable(data.employeeId, id);

    const mutation = await this.options.repository.updateWithAdminFloor(id, data);
    if (!mutation) throw notFound();
    if (mutation.changed) {
      await this.options.audit.record({
        actor,
        action: 'account.update',
        entityType: 'UserAccount',
        entityId: id,
        before: snapshot(mutation.before),
        after: snapshot(mutation.after),
        ...auditContext(context),
      });
    }
    return safeDto(mutation.after);
  }

  async deactivate(
    actor: AuditActor,
    accountId: string,
    context: AccountRequestContext = {},
  ): Promise<AccountDto> {
    assertAdmin(actor);
    const id = normalizeId(accountId, 'ID akun');
    const mutation = await this.options.repository.deactivateWithAdminFloor(id);
    if (!mutation) throw notFound();
    if (mutation.changed) {
      await this.options.audit.record({
        actor,
        action: 'account.deactivate',
        entityType: 'UserAccount',
        entityId: id,
        before: snapshot(mutation.before),
        after: snapshot(mutation.after),
        ...auditContext(context),
      });
    }
    return safeDto(mutation.after);
  }

  private assertAuthPasswordPolicy(password: unknown): asserts password is string {
    if (
      typeof password !== 'string' ||
      password.length === 0 ||
      password.length > MAX_PASSWORD_LENGTH ||
      Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      throw new Error('Temporary password generator returned a value rejected by AuthService.');
    }
  }

  private async assertUsernameAvailable(
    username: string,
    excludingAccountId?: string,
  ): Promise<void> {
    const [account, employee] = await Promise.all([
      this.options.repository.findByUsername(username),
      this.options.repository.findEmployeeByNik(username),
    ]);
    if (account && account.id !== excludingAccountId) throw usernameConflict();
    if (employee) throw usernameConflict();
  }

  private async assertEmployeeLinkAvailable(
    employeeId: string | null,
    accountId: string | null,
  ): Promise<void> {
    if (employeeId === null) return;
    const employee = await this.options.repository.findEmployeeById(employeeId);
    if (!employee) throw invalidInput('Karyawan yang dipilih tidak ditemukan.');
    if (employee.accountId && employee.accountId !== accountId) throw employeeLinkConflict();
  }
}
