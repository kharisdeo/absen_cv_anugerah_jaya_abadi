import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { MonthlyReportService } from '../modules/report/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { requestContext, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const monthlyReportQuerySchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    storeId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
  })
  .strict();

export type MonthlyReportRoutesOptions = Readonly<{
  service: MonthlyReportService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_REPORT_INPUT',
    'Filter laporan harus berisi month YYYY-MM dan UUID opsional yang valid.',
  );
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

export async function registerMonthlyReportRoutes(
  app: FastifyInstance,
  options: MonthlyReportRoutesOptions,
): Promise<void> {
  const readOptions = {
    config: { rateLimit: options.auth.sensitiveRateLimit ?? { max: 10, timeWindow: '15 minutes' } },
    onRequest: noStoreOnRequest,
    onSend: noStoreOnSend,
  } as const;

  app.get(`${API_PREFIX}/reports/monthly`, readOptions, async (request, reply) => {
    const query = monthlyReportQuerySchema.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const filter = {
      month: query.data.month,
      ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
      ...(query.data.employeeId === undefined ? {} : { employeeId: query.data.employeeId }),
    };
    const session = await requireSession(request, reply, options.auth);
    return options.service.monthlyReport(session.principal, filter);
  });

  app.get(`${API_PREFIX}/reports/monthly/export`, readOptions, async (request, reply) => {
    const query = monthlyReportQuerySchema.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const filter = {
      month: query.data.month,
      ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
      ...(query.data.employeeId === undefined ? {} : { employeeId: query.data.employeeId }),
    };
    const session = await requireSession(request, reply, options.auth);
    const buffer = await options.service.exportMonthlyReport(
      session.principal,
      filter,
      requestContext(request),
    );
    const filename = `rekap-absensi-${query.data.month}.xlsx`;
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(buffer);
  });
}
