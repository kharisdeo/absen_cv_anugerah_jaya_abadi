import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog, Prisma } from '../../src/generated/prisma/client.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import type { AuthPrincipal } from '../../src/modules/auth/contracts.js';
import {
  CONSENT_PURPOSES,
  ConsentService,
  createConsentPolicyProvider,
  hashConsentPolicyText,
  type ConsentCreateInput,
  type ConsentHistoryItem,
  type ConsentHistoryQuery,
  type ConsentRecord,
  type ConsentRepository,
} from '../../src/modules/consent/index.js';

const ACCOUNT_ID = 'd4bb1445-d860-40df-a8c6-cdd898daef80';
const OTHER_ACCOUNT_ID = '6436b4e6-4908-47c1-8c04-7d40f46c85c2';
const EMPLOYEE_ID = '4d04a7c2-35e8-499a-8a3b-78c730164e5b';
const ACCEPTED_AT = new Date('2026-10-11T02:03:04.000Z');
const POLICY_TEXT = 'Injected by deployment\nApproved privacy notice.';

function principal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    userAccountId: ACCOUNT_ID,
    role: UserRole.EMPLOYEE,
    username: 'employee',
    employeeId: EMPLOYEE_ID,
    deviceBindingId: null,
    deviceBindingStatus: null,
    mustChangePassword: true,
    consentRequired: false,
    sessionId: 'session-1',
    lastSeenAt: ACCEPTED_AT,
    ...overrides,
  };
}

class FakeConsentRepository implements ConsentRepository {
  readonly records: ConsentRecord[] = [];
  readonly historyQueries: ConsentHistoryQuery[] = [];
  createCalls = 0;
  private writeTail: Promise<void> = Promise.resolve();

  async findLatestForAccount(userAccountId: string): Promise<ConsentRecord | null> {
    return (
      [...this.records]
        .filter((record) => record.userAccountId === userAccountId)
        .sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime())[0] ?? null
    );
  }

  async acceptOnce(
    input: ConsentCreateInput,
  ): Promise<Readonly<{ record: ConsentRecord; created: boolean }>> {
    const previousWrite = this.writeTail;
    let releaseWrite!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await previousWrite;
    try {
      const existing = await this.findLatestForAccount(input.userAccountId);
      if (
        existing &&
        existing.withdrawnAt === null &&
        existing.policyVersion === input.policyVersion &&
        existing.consentTextHash === input.consentTextHash &&
        JSON.stringify(existing.purposes) === JSON.stringify(input.purposes)
      ) {
        return { record: existing, created: false };
      }
      this.createCalls += 1;
      const record: ConsentRecord = {
        id: `consent-${this.createCalls}`,
        ...input,
        purposes: JSON.parse(JSON.stringify(input.purposes)) as Prisma.JsonValue,
        withdrawnAt: null,
      };
      this.records.push(record);
      return { record, created: true };
    } finally {
      releaseWrite();
    }
  }

  async findHistory(query: ConsentHistoryQuery): Promise<readonly ConsentHistoryItem[]> {
    this.historyQueries.push(query);
    const scoped = this.records.filter((record) =>
      query.scope.kind === 'owner'
        ? record.userAccountId === query.scope.userAccountId
        : !query.scope.userAccountId || record.userAccountId === query.scope.userAccountId,
    );
    return scoped
      .slice(query.skip, query.skip + query.take)
      .map(({ id, policyVersion, purposes, acceptedAt, withdrawnAt }) => ({
        id,
        policyVersion,
        purposes,
        acceptedAt,
        withdrawnAt,
      }));
  }
}

function setup(config: { version?: string; text?: string } = { version: 'v1', text: POLICY_TEXT }) {
  const repository = new FakeConsentRepository();
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    record: async (event: RecordAuditEventInput) => {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  const service = new ConsentService({
    repository,
    policyProvider: createConsentPolicyProvider(config),
    audit,
    now: () => new Date(ACCEPTED_AT),
  });
  return { service, repository, auditEvents };
}

describe('consent policy and service', () => {
  it('accepts an absent policy only when both config values are absent, preserving injected text', () => {
    expect(createConsentPolicyProvider({}).getCurrentPolicy()).toBeNull();
    expect(() => createConsentPolicyProvider({ version: 'v1' })).toThrow(/berpasangan/);
    expect(() => createConsentPolicyProvider({ text: POLICY_TEXT })).toThrow(/berpasangan/);
    const policy = createConsentPolicyProvider({
      version: ' v1 ',
      text: POLICY_TEXT,
    }).getCurrentPolicy();
    expect(policy).toEqual({ version: 'v1', text: POLICY_TEXT, purposes: CONSENT_PURPOSES });
    expect(policy?.purposes.map(({ id }) => id)).toEqual([
      'selfie_attendance_proof',
      'location_on_attendance',
      'check_in_out_time',
      'attendance_recap',
      'selfie_retention',
    ]);
  });

  it('fails closed without policy and hashes the exact server-injected text on acceptance', async () => {
    const missing = setup({});
    expect(await missing.service.isConsentRequired(ACCOUNT_ID)).toBe(true);
    await expect(missing.service.current(ACCOUNT_ID)).rejects.toMatchObject({
      statusCode: 503,
      code: 'CONSENT_POLICY_UNAVAILABLE',
    });
    await expect(
      missing.service.accept(
        principal(),
        { policyVersion: 'v1', accepted: true },
        { clientIp: '192.0.2.4' },
      ),
    ).rejects.toMatchObject({ statusCode: 503 });

    const harness = setup();
    const accepted = await harness.service.accept(
      principal(),
      { policyVersion: 'v1', accepted: true },
      { clientIp: '192.0.2.4', requestId: '0e6db59a-513c-43a0-b6d5-d1d26f8eeaec' },
    );
    expect(accepted.record).toMatchObject({
      userAccountId: ACCOUNT_ID,
      employeeId: EMPLOYEE_ID,
      policyVersion: 'v1',
      consentTextHash: createHash('sha256').update(POLICY_TEXT, 'utf8').digest('hex'),
      acceptedAt: ACCEPTED_AT,
      clientIp: '192.0.2.4',
    });
    expect(accepted.record.consentTextHash).toBe(hashConsentPolicyText(POLICY_TEXT));
    expect(accepted.record.purposes).toEqual(CONSENT_PURPOSES);
    expect(harness.auditEvents[0]).toMatchObject({
      action: 'consent.accepted',
      entityType: 'ConsentRecord',
    });
    expect(harness.auditEvents[0]).not.toHaveProperty('before');
    expect(harness.auditEvents[0]).not.toHaveProperty('after');
    expect(harness.auditEvents[0]).not.toHaveProperty('clientIp');
  });

  it('rejects stale versions and safely treats duplicate acceptance as idempotent', async () => {
    const harness = setup();
    await expect(
      harness.service.accept(
        principal(),
        { policyVersion: 'old', accepted: true },
        { clientIp: '192.0.2.4' },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONSENT_POLICY_STALE' });
    const first = await harness.service.accept(
      principal(),
      { policyVersion: 'v1', accepted: true },
      { clientIp: '192.0.2.4' },
    );
    const second = await harness.service.accept(
      principal(),
      { policyVersion: 'v1', accepted: true },
      { clientIp: '203.0.113.10' },
    );
    expect(first.alreadyAccepted).toBe(false);
    expect(second).toEqual({ record: first.record, alreadyAccepted: true });
    expect(harness.repository.createCalls).toBe(1);
    expect(harness.auditEvents).toHaveLength(1);
  });

  it('keeps concurrent duplicate acceptance idempotent through the repository atomic contract', async () => {
    const harness = setup();
    const input = { policyVersion: 'v1', accepted: true };
    const context = { clientIp: '192.0.2.4' };
    const [first, second] = await Promise.all([
      harness.service.accept(principal(), input, context),
      harness.service.accept(principal(), input, context),
    ]);
    expect(harness.repository.records).toHaveLength(1);
    expect(harness.repository.createCalls).toBe(1);
    expect([first.alreadyAccepted, second.alreadyAccepted].sort()).toEqual([false, true]);
    expect(harness.auditEvents).toHaveLength(1);
  });

  it('marks missing, stale, or withdrawn policy acceptance as required and current acceptance as complete', async () => {
    const harness = setup();
    expect(await harness.service.isConsentRequired(ACCOUNT_ID)).toBe(true);
    const accepted = await harness.service.accept(
      principal(),
      { policyVersion: 'v1', accepted: true },
      { clientIp: '192.0.2.4' },
    );
    expect(await harness.service.isConsentRequired(ACCOUNT_ID)).toBe(false);
    const changedPolicy = new ConsentService({
      repository: harness.repository,
      policyProvider: createConsentPolicyProvider({ version: 'v2', text: POLICY_TEXT }),
      audit: { record: async () => ({}) as AuditLog },
      now: () => new Date(ACCEPTED_AT),
    });
    expect(await changedPolicy.isConsentRequired(ACCOUNT_ID)).toBe(true);
    harness.repository.records[0] = {
      ...accepted.record,
      withdrawnAt: new Date('2026-10-12T00:00:00.000Z'),
    };
    expect(await harness.service.isConsentRequired(ACCOUNT_ID)).toBe(true);
  });

  it('scopes history to the signed-in owner and allows Admin account filtering without exposing IP/hash', async () => {
    const harness = setup();
    await harness.service.accept(
      principal(),
      { policyVersion: 'v1', accepted: true },
      { clientIp: '192.0.2.4' },
    );
    await expect(
      harness.service.history(principal(), { accountId: OTHER_ACCOUNT_ID }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await harness.service.history(principal());
    expect(harness.repository.historyQueries.at(-1)?.scope).toEqual({
      kind: 'owner',
      userAccountId: ACCOUNT_ID,
    });
    await harness.service.history(
      principal({ role: UserRole.ADMIN, userAccountId: OTHER_ACCOUNT_ID, employeeId: null }),
      { accountId: ACCOUNT_ID },
    );
    expect(harness.repository.historyQueries.at(-1)?.scope).toEqual({
      kind: 'admin',
      userAccountId: ACCOUNT_ID,
    });
    expect(JSON.stringify((await harness.service.history(principal())).items)).not.toContain(
      '192.0.2.4',
    );
    expect(JSON.stringify((await harness.service.history(principal())).items)).not.toContain(
      hashConsentPolicyText(POLICY_TEXT),
    );
  });
});
