import { describe, expect, it } from 'vitest';

import { UserRole } from '../../src/generated/prisma/enums.js';
import { AppError } from '../../src/errors/app-error.js';
import type { AuditActor, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  SystemDisruptionService,
  type SystemDisruptionRecord,
  type SystemDisruptionRepository,
} from '../../src/modules/system-disruption/index.js';

const ADMIN_ID = 'd8bfc93a-bae8-4a7a-949b-234c68a81a2b';
const STORE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_STORE_ID = '00000000-0000-4000-8000-000000000002';
const actor: AuditActor = { userAccountId: ADMIN_ID, role: UserRole.ADMIN };
const start = '2026-10-11T09:00:00+07:00';
const end = '2026-10-11T11:00:00+07:00';

class FakeSystemDisruptionRepository implements SystemDisruptionRepository {
  readonly rows: SystemDisruptionRecord[] = [];
  readonly createInputs: Parameters<SystemDisruptionRepository['create']>[0][] = [];

  async create(input: Parameters<SystemDisruptionRepository['create']>[0]) {
    this.createInputs.push(input);
    const row: SystemDisruptionRecord = {
      ...input,
      isActive: true,
      createdAt: new Date('2026-10-11T03:00:00.000Z'),
      updatedAt: new Date('2026-10-11T03:00:00.000Z'),
    };
    this.rows.push(row);
    return row;
  }

  async list(input: Parameters<SystemDisruptionRepository['list']>[0]) {
    const rows = this.rows
      .filter((row) => input.storeId === undefined || row.storeId === input.storeId)
      .sort((left, right) => right.startsAt.getTime() - left.startsAt.getTime());
    const page = rows.slice(input.skip, input.take);
    return { items: page, hasNextPage: page.length === input.take };
  }
}

function makeService() {
  const repository = new FakeSystemDisruptionRepository();
  const events: RecordAuditEventInput[] = [];
  const service = new SystemDisruptionService(repository, {
    async record(event) {
      events.push(event);
      return {} as never;
    },
  });
  return { service, repository, events };
}

describe('SystemDisruptionService', () => {
  it('creates global and store-scoped records and appends an audit event', async () => {
    const { service, repository, events } = makeService();
    const global = await service.create(
      actor,
      { startsAt: start, endsAt: end, reason: '  Gangguan jaringan  ' },
      { clientIp: '127.0.0.1', requestId: '00000000-0000-4000-8000-000000000099' },
    );
    const scoped = await service.create(actor, {
      storeId: STORE_ID,
      startsAt: start,
      endsAt: end,
      reason: 'Gangguan perangkat toko',
    });

    expect(global).toMatchObject({ storeId: null, reason: 'Gangguan jaringan', isActive: true });
    expect(global.startsAt).toBe('2026-10-11T02:00:00.000Z');
    expect(scoped.storeId).toBe(STORE_ID);
    expect(repository.createInputs.map((input) => input.storeId)).toEqual([null, STORE_ID]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor,
      action: 'system_disruption.create',
      entityType: 'system_disruption',
      entityId: global.id,
      reason: 'Gangguan jaringan',
      clientIp: '127.0.0.1',
      requestId: '00000000-0000-4000-8000-000000000099',
    });
    expect(events[0]?.after).toEqual({
      storeId: null,
      startsAt: global.startsAt,
      endsAt: global.endsAt,
      isActive: true,
    });
  });

  it('rejects non-admin actors before repository access', async () => {
    const { service, repository, events } = makeService();
    await expect(
      service.list({ userAccountId: ADMIN_ID, role: UserRole.SUPERVISOR }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(
      service.create(
        { userAccountId: ADMIN_ID, role: UserRole.EMPLOYEE },
        { startsAt: start, endsAt: end, reason: 'No' },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(repository.createInputs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it.each([
    ['equal', start, start],
    ['reversed', end, start],
  ])('rejects %s interval end without writing or auditing', async (_case, startsAt, endsAt) => {
    const { service, repository, events } = makeService();
    await expect(
      service.create(actor, { startsAt, endsAt, reason: 'Gangguan' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SYSTEM_DISRUPTION' });
    expect(repository.createInputs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it.each([
    ['calendar date', '2026-02-30T09:00:00Z'],
    ['explicit timezone', '2026-10-11T09:00:00'],
    ['millisecond precision', '2026-10-11T09:00:00.1234Z'],
  ])('rejects invalid %s without writing', async (_case, startsAt) => {
    const { service, repository } = makeService();
    await expect(
      service.create(actor, { startsAt, endsAt: end, reason: 'Gangguan' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SYSTEM_DISRUPTION' });
    expect(repository.createInputs).toHaveLength(0);
  });

  it('requires a nonblank bounded reason', async () => {
    const { service, repository, events } = makeService();
    for (const reason of ['   ', 'x'.repeat(501)]) {
      await expect(
        service.create(actor, { startsAt: start, endsAt: end, reason }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_SYSTEM_DISRUPTION',
      });
    }
    expect(repository.createInputs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('allows overlapping active records as represented by the schema and lists them separately', async () => {
    const { service } = makeService();
    const first = await service.create(actor, {
      storeId: STORE_ID,
      startsAt: start,
      endsAt: end,
      reason: 'Pemadaman pertama',
    });
    const second = await service.create(actor, {
      storeId: STORE_ID,
      startsAt: '2026-10-11T10:00:00+07:00',
      endsAt: '2026-10-11T12:00:00+07:00',
      reason: 'Pemadaman kedua',
    });
    const all = await service.list(actor, { storeId: STORE_ID });
    const otherStore = await service.list(actor, { storeId: OTHER_STORE_ID });

    expect(all.items).toHaveLength(2);
    expect(new Set(all.items.map(({ id }) => id))).toEqual(new Set([first.id, second.id]));
    expect(otherStore.items).toEqual([]);
  });

  it('does not claim POST retries are idempotent without a persisted idempotency key', async () => {
    const { service, repository, events } = makeService();
    const input = { storeId: STORE_ID, startsAt: start, endsAt: end, reason: 'Gangguan' };

    const first = await service.create(actor, input);
    const retry = await service.create(actor, input);

    expect(first.id).not.toBe(retry.id);
    expect(repository.rows).toHaveLength(2);
    expect(events).toHaveLength(2);
  });
});
