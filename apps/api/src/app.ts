import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { env } from './config/env.js';
import type { ReadinessProbe } from './db/readiness.js';
import { registerErrorHandlers } from './errors/register-error-handlers.js';
import { registerApiHttpSecurity } from './plugins/http-security.js';
import type { AccountService } from './modules/account/index.js';
import type { AuditService } from './modules/audit/index.js';
import type { ConsentService } from './modules/consent/index.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAttendanceAttemptRoutes } from './routes/attendance-attempts.js';
import type { AttendanceAttemptRoutesOptions } from './routes/attendance-attempts.js';
import { registerAttendanceVerificationRoutes } from './routes/attendance-verifications.js';
import type { AttendanceVerificationRoutesOptions } from './routes/attendance-verifications.js';
import { registerAttendanceSelfieUploadRoutes } from './routes/attendance-selfie-uploads.js';
import type { AttendanceSelfieUploadRoutesOptions } from './routes/attendance-selfie-uploads.js';
import { registerAttendanceSelfieReadRoutes } from './routes/attendance-selfie-reads.js';
import { registerConsentRoutes } from './routes/consents.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import type { EmployeeRoutesOptions } from './routes/employees.js';
import { registerDeviceBindingRoutes } from './routes/device-bindings.js';
import type { DeviceBindingRoutesOptions } from './routes/device-bindings.js';
import type { ScheduleService } from './modules/schedule/index.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import type { ScheduleRoutesOptions } from './routes/schedule.js';
import { registerHealthRoute } from './routes/health.js';
import { registerStoreRoutes } from './routes/stores.js';
import type { StoreRoutesOptions } from './routes/stores.js';
import { registerSupervisorStoreAssignmentRoutes } from './routes/supervisor-store-assignments.js';
import type { SupervisorStoreAssignmentRoutesOptions } from './routes/supervisor-store-assignments.js';
import { registerAttendanceRequestRoutes } from './routes/attendance-requests.js';
import type { AttendanceRequestRoutesOptions } from './routes/attendance-requests.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import type { DashboardRoutesOptions } from './routes/dashboard.js';
import type { MonthlyReportService } from './modules/report/index.js';
import { registerMonthlyReportRoutes } from './routes/reports.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import type { NotificationRoutesOptions } from './routes/notifications.js';
import { registerAuditLogRoutes } from './routes/audit-logs.js';
import type { AuditLogRoutesOptions } from './routes/audit-logs.js';
import { registerSystemDisruptionRoutes } from './routes/system-disruptions.js';
import type { SystemDisruptionRoutesOptions } from './routes/system-disruptions.js';
import {
  registerAuthPlugins,
  registerAuthRoutes,
  requireSession,
  type AuthRoutesOptions,
} from './routes/auth.js';
import { API_PREFIX } from './shared/api-prefix.js';

export const loggerRedactions = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.employeeId',
  '*.userAccountId',
  '*.username',
  '*.fullName',
  '*.nik',
  '*.email',
  '*.phone',
  '*.clientIp',
  '*.ipAddress',
  '*.remoteAddress',
  '*.temporaryPassword',
  '*.token',
  '*.deviceToken',
  '*.deviceId',
  '*.deviceBindingId',
  '*.deviceIdHash',
  '*.idempotencyKey',
  '*.requestFingerprint',
  '*.selfieReferenceHash',
  '*.referenceHash',
  '*.objectKey',
  '*.sealedObjectKey',
  '*.uploadUrl',
  '*.url',
  '*.requiredHeaders',
  '*.headers',
  '*.referenceId',
  '*.proofCode',
  '*.selfie',
  '*.location',
  '*.blob',
  '*.dataBase64',
  '*.attachment',
]);

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  readiness?: ReadinessProbe;
  auth?: AuthRoutesOptions;
  accounts?: Readonly<{ service: AccountService }>;
  attendanceAttempts?: Pick<AttendanceAttemptRoutesOptions, 'service'>;
  attendanceVerifications?: Pick<AttendanceVerificationRoutesOptions, 'service'>;
  supervisorStoreAssignments?: Pick<SupervisorStoreAssignmentRoutesOptions, 'service'>;
  attendanceSelfieUploads?: Pick<AttendanceSelfieUploadRoutesOptions, 'service'> &
    Readonly<{ audit?: AuditService }>;
  consents?: Readonly<{ service: ConsentService }>;
  employees?: Pick<EmployeeRoutesOptions, 'service'>;
  stores?: Pick<StoreRoutesOptions, 'service'>;
  deviceBindings?: Pick<DeviceBindingRoutesOptions, 'service'>;
  schedule?: Readonly<{ service: ScheduleService }>;
  attendanceRequests?: Pick<AttendanceRequestRoutesOptions, 'service'>;
  dashboard?: Pick<DashboardRoutesOptions, 'service'>;
  monthlyReports?: Readonly<{ service: MonthlyReportService }>;
  notifications?: Pick<NotificationRoutesOptions, 'service'>;
  auditLogs?: Pick<AuditLogRoutesOptions, 'service'>;
  systemDisruptions?: Pick<SystemDisruptionRoutesOptions, 'service'>;
}

function isOnboardingEndpoint(method: string, requestUrl: string): boolean {
  const pathname = requestUrl.split('?', 1)[0] ?? requestUrl;
  if (method === 'OPTIONS') return true;
  const exemptPaths = new Set([
    `${API_PREFIX}/health`,
    `${API_PREFIX}/ready`,
    `${API_PREFIX}/auth/login`,
    `${API_PREFIX}/auth/me`,
    `${API_PREFIX}/auth/logout`,
    `${API_PREFIX}/auth/change-password`,
    `${API_PREFIX}/consents`,
    `${API_PREFIX}/consents/current`,
    `${API_PREFIX}/consents/history`,
  ]);
  return exemptPaths.has(pathname);
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? {
      level: env.LOG_LEVEL,
      redact: {
        paths: [...loggerRedactions],
        censor: '[REDACTED]',
      },
    },
    genReqId: () => randomUUID(),
  });

  registerApiHttpSecurity(app, env.APP_ORIGIN);
  registerErrorHandlers(app);
  if (options.auth) {
    app.decorateRequest('authSession', null);
    await registerAuthPlugins(app, options.auth);
    app.addHook('preHandler', async (request, reply) => {
      if (isOnboardingEndpoint(request.method, request.url)) return;
      const session = await requireSession(request, reply, options.auth!);
      options.auth!.service.requireRegularAccess(session.principal);
    });
  }
  await registerHealthRoute(app, options.readiness, env.APP_VERSION);
  if (options.auth) await registerAuthRoutes(app, options.auth);
  if (options.auth && options.accounts) {
    await registerAccountRoutes(app, { service: options.accounts.service, auth: options.auth });
  }
  if (options.auth && options.attendanceAttempts) {
    await registerAttendanceAttemptRoutes(app, {
      service: options.attendanceAttempts.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.attendanceVerifications) {
    await registerAttendanceVerificationRoutes(app, {
      service: options.attendanceVerifications.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.supervisorStoreAssignments) {
    await registerSupervisorStoreAssignmentRoutes(app, {
      service: options.supervisorStoreAssignments.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.attendanceSelfieUploads) {
    await registerAttendanceSelfieUploadRoutes(app, {
      service: options.attendanceSelfieUploads.service,
      auth: options.auth,
    });
    await registerAttendanceSelfieReadRoutes(app, {
      service: options.attendanceSelfieUploads.service,
      auth: options.auth,
      ...(options.attendanceSelfieUploads.audit
        ? { audit: options.attendanceSelfieUploads.audit }
        : {}),
    });
  }
  if (options.auth && options.consents) {
    await registerConsentRoutes(app, { service: options.consents.service, auth: options.auth });
  }
  if (options.auth && options.employees) {
    await registerEmployeeRoutes(app, { service: options.employees.service, auth: options.auth });
  }
  if (options.auth && options.stores) {
    await registerStoreRoutes(app, { service: options.stores.service, auth: options.auth });
  }
  if (options.auth && options.deviceBindings) {
    await registerDeviceBindingRoutes(app, {
      service: options.deviceBindings.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.schedule) {
    await registerScheduleRoutes(app, {
      service: options.schedule.service,
      auth: options.auth,
    } satisfies ScheduleRoutesOptions);
  }
  if (options.auth && options.attendanceRequests) {
    await registerAttendanceRequestRoutes(app, {
      service: options.attendanceRequests.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.dashboard) {
    await registerDashboardRoutes(app, {
      service: options.dashboard.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.monthlyReports) {
    await registerMonthlyReportRoutes(app, {
      service: options.monthlyReports.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.notifications) {
    await registerNotificationRoutes(app, {
      service: options.notifications.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.auditLogs) {
    await registerAuditLogRoutes(app, {
      service: options.auditLogs.service,
      auth: options.auth,
    });
  }
  if (options.auth && options.systemDisruptions) {
    await registerSystemDisruptionRoutes(app, {
      service: options.systemDisruptions.service,
      auth: options.auth,
    });
  }

  return app;
}
