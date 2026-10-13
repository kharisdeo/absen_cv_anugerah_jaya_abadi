import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { UserRole } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { AuthPrincipal } from '../modules/auth/contracts.js';
import type { DeviceBindingDto, DeviceBindingService } from '../modules/device-binding/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const bindingParams = z.object({ bindingId: z.string().uuid() }).strict();
const emptyBody = z.object({}).strict().optional();

export type DeviceBindingRoutesOptions = Readonly<{
  service: DeviceBindingService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_DEVICE_BINDING_INPUT',
    'Parameter atau payload pendaftaran perangkat tidak valid.',
  );
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola perangkat.');
  }
}

function auditActor(principal: AuthPrincipal): AuditActor {
  return { userAccountId: principal.userAccountId, role: UserRole.ADMIN };
}

function toSafeDto(binding: DeviceBindingDto): DeviceBindingDto {
  return {
    id: binding.id,
    employeeId: binding.employeeId,
    deviceName: binding.deviceName,
    status: binding.status,
    requestedAt: binding.requestedAt,
    approvedAt: binding.approvedAt,
    revokedAt: binding.revokedAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

async function setNoStoreOnRequest(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  setNoStore(reply);
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerDeviceBindingRoutes(
  app: FastifyInstance,
  options: DeviceBindingRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/device-bindings`;
  const sensitiveRateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await requireSession(request, reply, options.auth);
    assertAdmin(session.principal);
  };

  app.get(
    `${base}/pending`,
    {
      onRequest: setNoStoreOnRequest,
      onSend: setNoStoreOnSend,
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const session = await requireSession(request, reply, options.auth);
      const bindings = await options.service.listPending(auditActor(session.principal));
      return bindings.map(toSafeDto);
    },
  );

  for (const action of ['approve', 'revoke'] as const) {
    app.post<{ Params: { bindingId: string } }>(
      `${base}/:bindingId/${action}`,
      {
        config: { rateLimit: sensitiveRateLimit },
        onRequest: async (request, reply) => {
          await setNoStoreOnRequest(request, reply);
          assertAllowedOrigin(request, options.auth);
        },
        onSend: setNoStoreOnSend,
        preHandler: authorizeAdmin,
      },
      async (request, reply) => {
        const params = bindingParams.safeParse(request.params);
        const body = emptyBody.safeParse(request.body);
        if (!params.success || !body.success) throw invalidInput();

        const session = await requireSession(request, reply, options.auth);
        const actor = auditActor(session.principal);
        const context = requestContext(request);
        const binding =
          action === 'approve'
            ? await options.service.approve(actor, params.data.bindingId, context)
            : await options.service.revoke(actor, params.data.bindingId, context);
        return toSafeDto(binding);
      },
    );
  }
}
