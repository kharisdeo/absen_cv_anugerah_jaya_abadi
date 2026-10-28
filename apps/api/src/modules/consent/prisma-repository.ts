import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  ConsentCreateInput,
  ConsentHistoryItem,
  ConsentHistoryQuery,
  ConsentRecord,
  ConsentRepository,
} from './index.js';

type ConsentRow = Prisma.ConsentRecordGetPayload<Record<string, never>>;

function mapRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    userAccountId: row.userAccountId,
    employeeId: row.employeeId,
    policyVersion: row.policyVersion,
    consentTextHash: row.consentTextHash,
    purposes: row.purposes,
    acceptedAt: row.acceptedAt,
    withdrawnAt: row.withdrawnAt,
    clientIp: row.clientIp,
  };
}

function samePurposes(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class PrismaConsentRepository implements ConsentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestForAccount(userAccountId: string): Promise<ConsentRecord | null> {
    const row = await this.prisma.consentRecord.findFirst({
      where: { userAccountId },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
    });
    return row ? mapRecord(row) : null;
  }

  async acceptOnce(
    input: ConsentCreateInput,
  ): Promise<Readonly<{ record: ConsentRecord; created: boolean }>> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize this account/policy pair across app instances; no schema uniqueness constraint
      // or migration is required, and a retry after a committed request is idempotent.
      // Keep the transaction-scoped lock while returning only a Prisma-supported scalar.
      // Selecting pg_advisory_xact_lock directly exposes PostgreSQL's `void` result type,
      // which Prisma's PostgreSQL adapter cannot deserialize.
      await tx.$queryRaw(
        Prisma.sql`
          WITH consent_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(
              hashtext(${input.userAccountId}),
              hashtext(${input.policyVersion})
            )
          )
          SELECT TRUE AS locked FROM consent_lock
        `,
      );
      const latest = await tx.consentRecord.findFirst({
        where: { userAccountId: input.userAccountId },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      });
      if (
        latest &&
        latest.withdrawnAt === null &&
        latest.policyVersion === input.policyVersion &&
        latest.consentTextHash === input.consentTextHash &&
        samePurposes(latest.purposes, input.purposes)
      ) {
        return { record: mapRecord(latest), created: false };
      }

      const created = await tx.consentRecord.create({ data: input });
      return { record: mapRecord(created), created: true };
    });
  }

  async findHistory(query: ConsentHistoryQuery): Promise<readonly ConsentHistoryItem[]> {
    const where: Prisma.ConsentRecordWhereInput =
      query.scope.kind === 'owner'
        ? { userAccountId: query.scope.userAccountId }
        : query.scope.userAccountId
          ? { userAccountId: query.scope.userAccountId }
          : {};
    const rows = await this.prisma.consentRecord.findMany({
      where,
      select: {
        id: true,
        policyVersion: true,
        purposes: true,
        acceptedAt: true,
        withdrawnAt: true,
      },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    return rows;
  }
}
