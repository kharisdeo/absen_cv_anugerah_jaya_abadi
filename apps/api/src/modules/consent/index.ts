import { createHash } from 'node:crypto';

import { UserRole } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditService } from '../audit/index.js';
import type { AuthPrincipal } from '../auth/contracts.js';

export type ConsentPurpose = Readonly<{ id: string; label: string }>;
export type ConsentPolicy = Readonly<{
  version: string;
  text: string;
  purposes: readonly ConsentPurpose[];
}>;

/** Legal wording and version must be injected from company-approved server configuration. */
export type ConsentPolicyConfiguration = Readonly<{ version?: string; text?: string }>;

export interface ConsentPolicyProvider {
  getCurrentPolicy(): ConsentPolicy | null;
}

// Limited to the data uses explicitly present in the PRD/TODO; no additional purposes are implied.
export const CONSENT_PURPOSES = [
  { id: 'selfie_attendance_proof', label: 'Selfie sebagai bukti absensi.' },
  {
    id: 'location_on_attendance',
    label: 'Lokasi hanya diambil saat tombol Masuk/Pulang ditekan untuk validasi lokasi kerja.',
  },
  { id: 'check_in_out_time', label: 'Pencatatan waktu check-in dan check-out.' },
  { id: 'attendance_recap', label: 'Penggunaan data untuk kehadiran dan rekap absensi.' },
  { id: 'selfie_retention', label: 'Retensi selfie dengan masa default 12 bulan.' },
] as const satisfies readonly ConsentPurpose[];

export function createConsentPolicyProvider(
  configuration: ConsentPolicyConfiguration,
): ConsentPolicyProvider {
  const version = configuration.version?.trim();
  const text = configuration.text;
  const hasVersion = Boolean(version);
  const hasText = typeof text === 'string' && text.trim().length > 0;
  if (hasVersion !== hasText) {
    throw new Error('CONSENT_POLICY_VERSION dan CONSENT_POLICY_TEXT harus diisi berpasangan.');
  }
  if (!version || !text || !text.trim()) {
    return Object.freeze({ getCurrentPolicy: () => null });
  }
  if (version.length > 100 || text.length > 50_000) {
    throw new Error('Konfigurasi consent policy melebihi batas panjang.');
  }

  const policy: ConsentPolicy = Object.freeze({ version, text, purposes: CONSENT_PURPOSES });
  return Object.freeze({ getCurrentPolicy: () => policy });
}

export function hashConsentPolicyText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type ConsentRecord = Readonly<{
  id: string;
  userAccountId: string;
  employeeId: string | null;
  policyVersion: string;
  consentTextHash: string;
  purposes: Prisma.JsonValue;
  acceptedAt: Date;
  withdrawnAt: Date | null;
  clientIp: string | null;
}>;

export type ConsentHistoryItem = Readonly<{
  id: string;
  policyVersion: string;
  purposes: Prisma.JsonValue;
  acceptedAt: Date;
  withdrawnAt: Date | null;
}>;

export type ConsentCreateInput = Readonly<{
  userAccountId: string;
  employeeId: string | null;
  policyVersion: string;
  consentTextHash: string;
  purposes: Prisma.InputJsonValue;
  acceptedAt: Date;
  clientIp: string;
  deviceIdHash: null;
}>;

export type ConsentHistoryScope =
  | Readonly<{ kind: 'owner'; userAccountId: string }>
  | Readonly<{ kind: 'admin'; userAccountId?: string }>;

export type ConsentHistoryQuery = Readonly<{
  scope: ConsentHistoryScope;
  skip: number;
  take: number;
}>;

/** Persistence must scope every query and make acceptOnce atomic across API instances. */
export interface ConsentRepository {
  findLatestForAccount(userAccountId: string): Promise<ConsentRecord | null>;
  acceptOnce(
    input: ConsentCreateInput,
  ): Promise<Readonly<{ record: ConsentRecord; created: boolean }>>;
  findHistory(query: ConsentHistoryQuery): Promise<readonly ConsentHistoryItem[]>;
}

export type ConsentCurrentResponse = Readonly<{
  policy: ConsentPolicy;
  consentRequired: boolean;
}>;

export interface ConsentServiceOptions {
  repository: ConsentRepository;
  policyProvider: ConsentPolicyProvider;
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

function isSamePurposes(stored: unknown, current: ConsentPolicy['purposes']): boolean {
  return JSON.stringify(stored) === JSON.stringify(current);
}

function isCurrentRecord(record: ConsentRecord | null, policy: ConsentPolicy): boolean {
  return Boolean(
    record &&
    record.withdrawnAt === null &&
    record.policyVersion === policy.version &&
    record.consentTextHash === hashConsentPolicyText(policy.text) &&
    isSamePurposes(record.purposes, policy.purposes),
  );
}

function auditActor(principal: AuthPrincipal) {
  return {
    userAccountId: principal.userAccountId,
    role: principal.role,
    ...(principal.role === UserRole.EMPLOYEE ? { employeeId: principal.employeeId } : {}),
  };
}

function unavailablePolicy(): AppError {
  return new AppError(
    503,
    'CONSENT_POLICY_UNAVAILABLE',
    'Kebijakan privasi belum dikonfigurasi. Silakan coba kembali nanti.',
  );
}

export class ConsentService {
  private readonly now: () => Date;

  constructor(private readonly options: ConsentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async isConsentRequired(userAccountId: string): Promise<boolean> {
    const policy = this.options.policyProvider.getCurrentPolicy();
    if (!policy) return true;
    const latest = await this.options.repository.findLatestForAccount(userAccountId);
    return !isCurrentRecord(latest, policy);
  }

  async current(userAccountId: string): Promise<ConsentCurrentResponse> {
    const policy = this.options.policyProvider.getCurrentPolicy();
    if (!policy) throw unavailablePolicy();
    return { policy, consentRequired: await this.isConsentRequired(userAccountId) };
  }

  async accept(
    principal: AuthPrincipal,
    input: Readonly<{ policyVersion: unknown; accepted: unknown }>,
    context: Readonly<{ clientIp: string; requestId?: string }>,
  ): Promise<Readonly<{ record: ConsentRecord; alreadyAccepted: boolean }>> {
    const policy = this.options.policyProvider.getCurrentPolicy();
    if (!policy) throw unavailablePolicy();
    if (input.accepted !== true || input.policyVersion !== policy.version) {
      throw new AppError(
        409,
        'CONSENT_POLICY_STALE',
        'Kebijakan berubah atau belum disetujui. Muat kebijakan terbaru.',
      );
    }

    const latest = await this.options.repository.findLatestForAccount(principal.userAccountId);
    if (isCurrentRecord(latest, policy)) return { record: latest!, alreadyAccepted: true };

    const result = await this.options.repository.acceptOnce({
      userAccountId: principal.userAccountId,
      employeeId: principal.employeeId,
      policyVersion: policy.version,
      consentTextHash: hashConsentPolicyText(policy.text),
      purposes: policy.purposes.map(({ id, label }) => ({ id, label })),
      acceptedAt: this.now(),
      clientIp: context.clientIp,
      deviceIdHash: null,
    });
    if (result.created) {
      await this.options.audit.record({
        actor: auditActor(principal),
        action: 'consent.accepted',
        entityType: 'ConsentRecord',
        entityId: result.record.id,
        ...(context.requestId ? { requestId: context.requestId } : {}),
      });
    }
    return { record: result.record, alreadyAccepted: !result.created };
  }

  async history(
    principal: AuthPrincipal,
    filter: Readonly<{ accountId?: string; page?: number; pageSize?: number }> = {},
  ) {
    const page = filter.page ?? 1;
    const pageSize = filter.pageSize ?? 50;
    if (!Number.isInteger(page) || page < 1 || page > 10_000) {
      throw new AppError(400, 'INVALID_INPUT', 'page di luar batas.');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AppError(400, 'INVALID_INPUT', 'pageSize di luar batas.');
    }

    let scope: ConsentHistoryScope;
    if (principal.role === UserRole.ADMIN) {
      scope = { kind: 'admin', ...(filter.accountId ? { userAccountId: filter.accountId } : {}) };
    } else {
      if (filter.accountId && filter.accountId !== principal.userAccountId) {
        throw new AppError(403, 'FORBIDDEN', 'Riwayat consent hanya dapat dilihat pemiliknya.');
      }
      scope = { kind: 'owner', userAccountId: principal.userAccountId };
    }

    const rows = await this.options.repository.findHistory({
      scope,
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
    });
    return {
      items: rows.slice(0, pageSize),
      page,
      pageSize,
      hasNextPage: rows.length > pageSize,
    };
  }
}
