import { buildApp } from './app.js';
import { env } from './config/env.js';
import { createPrismaClient } from './db/prisma.js';
import { createDatabaseReadinessProbe } from './db/readiness.js';
import { AuditService } from './modules/audit/index.js';
import { AccountService } from './modules/account/index.js';
import { PrismaAccountRepository } from './modules/account/prisma-repository.js';
import {
  AttendanceAttemptService,
  UnavailableAttendanceEvidenceVerifier,
} from './modules/attendance/index.js';
import { PrismaAttendanceAttemptRepository } from './modules/attendance/prisma-repository.js';
import { PrismaAttendanceVerificationRepository } from './modules/attendance/prisma-verification-repository.js';
import { PrismaSelfieUploadIntentRepository } from './modules/attendance/prisma-selfie-upload-repository.js';
import { AttendanceVerificationService } from './modules/attendance/verification-workflow.js';
import {
  S3PrivateSelfieStorage,
  UnavailablePrivateSelfieStorage,
} from './modules/attendance/private-selfie-storage.js';
import { SelfieUploadService } from './modules/attendance/selfie-upload.js';
import { argon2PasswordHasher, createArgon2AuthService } from './modules/auth/argon2.js';
import {
  PrismaAuditLogRepository,
  PrismaAuthRepository,
} from './modules/auth/prisma-repository.js';
import { createConsentPolicyProvider, ConsentService } from './modules/consent/index.js';
import { PrismaConsentRepository } from './modules/consent/prisma-repository.js';
import { DeviceBindingService } from './modules/device-binding/index.js';
import { PrismaDeviceBindingRepository } from './modules/device-binding/prisma-repository.js';
import { EmployeeService } from './modules/employee/index.js';
import { PrismaEmployeeRepository } from './modules/employee/prisma-repository.js';
import { StoreService } from './modules/store/index.js';
import { PrismaStoreRepository } from './modules/store/prisma-repository.js';
import { ScheduleService } from './modules/schedule/index.js';
import { PrismaScheduleRepository } from './modules/schedule/prisma-repository.js';
import { SupervisorStoreAssignmentService } from './modules/supervisor-store-assignment/index.js';
import { PrismaSupervisorStoreAssignmentRepository } from './modules/supervisor-store-assignment/prisma-repository.js';
import { AttendanceRequestService } from './modules/attendance-requests/index.js';
import { PrismaAttendanceRequestRepository } from './modules/attendance-requests/prisma-repository.js';
import {
  S3PrivateRequestAttachmentStorage,
  UnavailablePrivateRequestAttachmentStorage,
} from './modules/attendance-requests/private-request-attachment-storage.js';
import { DashboardService } from './modules/dashboard/index.js';
import { PrismaDashboardRepository } from './modules/dashboard/prisma-repository.js';
import { MonthlyReportService } from './modules/report/index.js';
import { PrismaMonthlyReportRepository } from './modules/report/prisma-repository.js';
import { NotificationService } from './modules/notifications/index.js';
import { PrismaNotificationRepository } from './modules/notifications/prisma-repository.js';
import { SystemDisruptionService } from './modules/system-disruption/index.js';
import { PrismaSystemDisruptionRepository } from './modules/system-disruption/prisma-repository.js';

const secureRuntime = env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';
if (secureRuntime && !env.DATABASE_URL) {
  throw new Error('DATABASE_URL wajib dikonfigurasi untuk menjalankan API staging/production.');
}

const prisma = env.DATABASE_URL ? createPrismaClient(env.DATABASE_URL) : undefined;
const consentPolicyProvider = createConsentPolicyProvider({
  ...(env.CONSENT_POLICY_VERSION ? { version: env.CONSENT_POLICY_VERSION } : {}),
  ...(env.CONSENT_POLICY_TEXT === undefined ? {} : { text: env.CONSENT_POLICY_TEXT }),
});
const audit = prisma ? new AuditService(new PrismaAuditLogRepository(prisma)) : undefined;
const consents =
  prisma && audit
    ? new ConsentService({
        repository: new PrismaConsentRepository(prisma),
        policyProvider: consentPolicyProvider,
        audit,
      })
    : undefined;
const employees =
  prisma && audit ? new EmployeeService(new PrismaEmployeeRepository(prisma), audit) : undefined;
const stores =
  prisma && audit ? new StoreService(new PrismaStoreRepository(prisma), audit) : undefined;
const schedule =
  prisma && audit ? new ScheduleService(new PrismaScheduleRepository(prisma), audit) : undefined;
const selfieStorage =
  env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
    ? new S3PrivateSelfieStorage({
        ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
        region: env.STORAGE_REGION,
        bucket: env.STORAGE_BUCKET,
        accessKey: env.STORAGE_ACCESS_KEY,
        secretKey: env.STORAGE_SECRET_KEY,
      })
    : new UnavailablePrivateSelfieStorage();
const requestAttachmentStorage =
  env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
    ? new S3PrivateRequestAttachmentStorage({
        ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
        region: env.STORAGE_REGION,
        bucket: env.STORAGE_BUCKET,
        accessKey: env.STORAGE_ACCESS_KEY,
        secretKey: env.STORAGE_SECRET_KEY,
      })
    : new UnavailablePrivateRequestAttachmentStorage();
const selfieUploads = prisma
  ? new SelfieUploadService(
      new PrismaSelfieUploadIntentRepository(prisma),
      selfieStorage,
      env.SELFIE_UPLOAD_URL_TTL_SECONDS,
    )
  : undefined;
const attendanceAttempts =
  prisma && audit
    ? new AttendanceAttemptService(
        new PrismaAttendanceAttemptRepository(prisma),
        selfieUploads ?? new UnavailableAttendanceEvidenceVerifier(),
        env.SELFIE_RETENTION_MONTHS,
      )
    : undefined;
const attendanceVerifications =
  prisma && selfieUploads
    ? new AttendanceVerificationService(
        new PrismaAttendanceVerificationRepository(prisma),
        selfieUploads,
      )
    : undefined;
const supervisorStoreAssignments = prisma
  ? new SupervisorStoreAssignmentService(new PrismaSupervisorStoreAssignmentRepository(prisma))
  : undefined;
const attendanceRequests = prisma
  ? new AttendanceRequestService(
      new PrismaAttendanceRequestRepository(prisma),
      requestAttachmentStorage,
    )
  : undefined;
const dashboard = prisma
  ? new DashboardService(new PrismaDashboardRepository(prisma), undefined, env.TIMEZONE)
  : undefined;
const monthlyReports =
  prisma && audit
    ? new MonthlyReportService(new PrismaMonthlyReportRepository(prisma), audit)
    : undefined;
const notifications = prisma
  ? new NotificationService(new PrismaNotificationRepository(prisma))
  : undefined;
const systemDisruptions =
  prisma && audit
    ? new SystemDisruptionService(new PrismaSystemDisruptionRepository(prisma), audit)
    : undefined;
const accounts =
  prisma && audit
    ? new AccountService({
        repository: new PrismaAccountRepository(prisma),
        audit,
        passwordHasher: argon2PasswordHasher,
      })
    : undefined;
const deviceBindings =
  prisma && audit
    ? new DeviceBindingService({
        repository: new PrismaDeviceBindingRepository(prisma),
        audit,
      })
    : undefined;
const auth = prisma
  ? {
      service: await createArgon2AuthService(
        new PrismaAuthRepository(prisma),
        audit!,
        consents!,
        deviceBindings,
      ),
      ...(env.SESSION_SECRET === undefined ? {} : { cookieSecret: env.SESSION_SECRET }),
      secureCookies: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
      allowedOrigin: env.APP_ORIGIN ?? '',
    }
  : undefined;
const app = await buildApp({
  ...(prisma ? { readiness: createDatabaseReadinessProbe(prisma) } : {}),
  ...(auth ? { auth } : {}),
  ...(accounts ? { accounts: { service: accounts } } : {}),
  ...(attendanceAttempts ? { attendanceAttempts: { service: attendanceAttempts } } : {}),
  ...(attendanceVerifications
    ? { attendanceVerifications: { service: attendanceVerifications } }
    : {}),
  ...(supervisorStoreAssignments
    ? { supervisorStoreAssignments: { service: supervisorStoreAssignments } }
    : {}),
  ...(selfieUploads
    ? { attendanceSelfieUploads: { service: selfieUploads, ...(audit ? { audit } : {}) } }
    : {}),
  ...(consents ? { consents: { service: consents } } : {}),
  ...(employees ? { employees: { service: employees } } : {}),
  ...(stores ? { stores: { service: stores } } : {}),
  ...(deviceBindings ? { deviceBindings: { service: deviceBindings } } : {}),
  ...(schedule ? { schedule: { service: schedule } } : {}),
  ...(attendanceRequests ? { attendanceRequests: { service: attendanceRequests } } : {}),
  ...(dashboard ? { dashboard: { service: dashboard } } : {}),
  ...(monthlyReports ? { monthlyReports: { service: monthlyReports } } : {}),
  ...(notifications ? { notifications: { service: notifications } } : {}),
  ...(audit ? { auditLogs: { service: audit } } : {}),
  ...(systemDisruptions ? { systemDisruptions: { service: systemDisruptions } } : {}),
});
if (prisma) app.addHook('onClose', async () => prisma.$disconnect());
if (selfieStorage instanceof S3PrivateSelfieStorage) {
  app.addHook('onClose', async () => selfieStorage.close());
}
if (requestAttachmentStorage instanceof S3PrivateRequestAttachmentStorage) {
  app.addHook('onClose', async () => requestAttachmentStorage.close());
}
let isClosing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isClosing) {
    return;
  }

  isClosing = true;
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error, signal }, 'API shutdown failed');
      process.exitCode = 1;
    });
  });
}

try {
  const address = await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info({ address }, 'API listening');
} catch (error: unknown) {
  app.log.error({ err: error }, 'API failed to start');
  await app.close();
  process.exitCode = 1;
}
