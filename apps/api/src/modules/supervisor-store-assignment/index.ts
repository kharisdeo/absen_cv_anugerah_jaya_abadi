import { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';

export type SupervisorStoreAssignmentDto = Readonly<{
  supervisorUserAccountId: string;
  supervisorUsername: string;
  storeId: string;
  storeName: string;
  assignedByUserAccountId: string | null;
  assignedAt: Date;
}>;

export type SupervisorStoreAssignmentFilter = Readonly<{
  supervisorUserAccountId?: string;
  storeId?: string;
}>;

export interface SupervisorStoreAssignmentRepository {
  list(filter: SupervisorStoreAssignmentFilter): Promise<readonly SupervisorStoreAssignmentDto[]>;
  create(
    input: Readonly<{
      supervisorUserAccountId: string;
      storeId: string;
      assignedByUserAccountId: string;
      requestId: string;
    }>,
  ): Promise<SupervisorStoreAssignmentDto>;
  delete(
    input: Readonly<{
      supervisorUserAccountId: string;
      storeId: string;
      assignedByUserAccountId: string;
      requestId: string;
    }>,
  ): Promise<void>;
}

function requireAdmin(principal: AuthPrincipal): void {
  if (principal.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola penugasan Supervisor.');
  }
}

export class SupervisorStoreAssignmentService {
  constructor(private readonly repository: SupervisorStoreAssignmentRepository) {}

  list(principal: AuthPrincipal, filter: SupervisorStoreAssignmentFilter = {}) {
    requireAdmin(principal);
    return this.repository.list(filter);
  }

  create(
    principal: AuthPrincipal,
    input: Readonly<{ supervisorUserAccountId: string; storeId: string }>,
    requestId: string,
  ) {
    requireAdmin(principal);
    return this.repository.create({
      ...input,
      assignedByUserAccountId: principal.userAccountId,
      requestId,
    });
  }

  async delete(
    principal: AuthPrincipal,
    input: Readonly<{ supervisorUserAccountId: string; storeId: string }>,
    requestId: string,
  ): Promise<void> {
    requireAdmin(principal);
    await this.repository.delete({
      ...input,
      assignedByUserAccountId: principal.userAccountId,
      requestId,
    });
  }
}
