import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { DashboardService } from '../modules/dashboard/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const dashboardQuerySchema = z
  .object({
    date: z.string().max(10).optional(),
    storeId: z.string().uuid().optional(),
    shiftId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const employeeQuerySchema = z
  .object({
    historyPage: z.coerce.number().int().min(1).max(10_000).optional(),
    historyPageSize: z.coerce.number().int().min(1).max(50).optional(),
    historyFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    historyTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    requestPage: z.coerce.number().int().min(1).max(10_000).optional(),
    requestPageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export type DashboardRoutesOptions = Readonly<{
  service: DashboardService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_DASHBOARD_INPUT', 'Parameter dashboard tidak valid.');
}

async function noStoreOnRequest(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  setNoStore(reply);
}

async function noStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: DashboardRoutesOptions,
): Promise<void> {
  app.get(
    `${API_PREFIX}/dashboard`,
    { onRequest: noStoreOnRequest, onSend: noStoreOnSend },
    async (request, reply) => {
      const query = dashboardQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.adminDashboard(session.principal, {
        ...(query.data.date === undefined ? {} : { date: query.data.date }),
        ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
        ...(query.data.shiftId === undefined ? {} : { shiftId: query.data.shiftId }),
        ...(query.data.page === undefined ? {} : { page: query.data.page }),
        ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
      });
    },
  );

  app.get(
    `${API_PREFIX}/me/dashboard`,
    { onRequest: noStoreOnRequest, onSend: noStoreOnSend },
    async (request, reply) => {
      const query = employeeQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.employeeDashboard(session.principal, {
        ...(query.data.historyPage === undefined ? {} : { historyPage: query.data.historyPage }),
        ...(query.data.historyPageSize === undefined
          ? {}
          : { historyPageSize: query.data.historyPageSize }),
        ...(query.data.historyFrom === undefined ? {} : { historyFrom: query.data.historyFrom }),
        ...(query.data.historyTo === undefined ? {} : { historyTo: query.data.historyTo }),
        ...(query.data.requestPage === undefined ? {} : { requestPage: query.data.requestPage }),
        ...(query.data.requestPageSize === undefined
          ? {}
          : { requestPageSize: query.data.requestPageSize }),
      });
    },
  );
}
