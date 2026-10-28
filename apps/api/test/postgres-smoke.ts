import { existsSync } from 'node:fs';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { AttendanceEvidenceReferenceVerifier } from '../src/modules/attendance/index.js';
import {
  assertEphemeralDatabaseUrl,
  EXPECTED_DATABASE_NAME,
  EXPECTED_DATABASE_USER,
  SmokeCheckError,
} from './postgres-smoke-guard.js';
import { readSignedSessionCookie, SESSION_COOKIE_NAME } from './postgres-smoke-cookie.js';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const LOGIN_FAILURE_LIMIT = 5;
const POSTGRES_PROBE_TIMEOUT_MS = 15_000;
// Mirrors LOCK_DURATION_MS in src/modules/auth/service.ts; keep this aligned with production.
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
// pg_trigger.tgtype: ROW | BEFORE | DELETE | UPDATE.
const EXPECTED_UPDATE_DELETE_TRIGGER_TYPE = 27;

function requireCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SmokeCheckError(message);
}

function hasGenericOkBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;

  const value = body as Record<string, unknown>;
  return Object.keys(value).length === 1 && value.status === 'ok';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertPublicAuthResponse(
  body: unknown,
  fixture: Readonly<{ id: string; username: string }>,
  expected: Readonly<{
    role: 'ADMIN' | 'SUPERVISOR' | 'EMPLOYEE';
    employeeId: string | null;
    deviceBindingStatus: 'PENDING' | 'APPROVED' | 'REVOKED' | null;
  }> = { role: 'ADMIN', employeeId: null, deviceBindingStatus: null },
): void {
  requireCheck(isRecord(body), 'Auth endpoint must return the public user response.');
  requireCheck(
    hasExactKeys(body, ['user', 'consentRequired']),
    'Auth endpoint must return only the public user response fields.',
  );
  requireCheck(
    body.consentRequired === true,
    'Auth endpoint must report the current consent gate.',
  );
  requireCheck(isRecord(body.user), 'Auth endpoint must return a public user.');

  const user = body.user;
  requireCheck(
    hasExactKeys(user, [
      'id',
      'username',
      'role',
      'employeeId',
      'deviceBindingStatus',
      'mustChangePassword',
      'consentRequired',
    ]),
    'Auth endpoint must not return password, token, or internal session fields.',
  );
  requireCheck(
    user.id === fixture.id &&
      user.username === fixture.username &&
      user.role === expected.role &&
      user.employeeId === expected.employeeId &&
      user.deviceBindingStatus === expected.deviceBindingStatus &&
      user.mustChangePassword === false &&
      user.consentRequired === true,
    'Auth endpoint returned an unexpected public user identity.',
  );
}

function assertGenericInvalidCredentialsResponse(
  response: Readonly<{
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
  }>,
  secrets: readonly string[],
): void {
  requireCheck(response.statusCode === 401, 'Invalid or locked login must return HTTP 401.');
  requireCheck(
    response.headers['cache-control'] === 'no-store',
    'Invalid or locked login must include Cache-Control: no-store.',
  );
  requireCheck(
    typeof response.headers['content-type'] === 'string' &&
      response.headers['content-type'].startsWith('application/problem+json'),
    'Invalid or locked login must return the generic problem response.',
  );
  requireCheck(
    response.headers['set-cookie'] === undefined,
    'Invalid or locked login must not set a session cookie.',
  );

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new SmokeCheckError('Invalid or locked login must return a valid generic problem body.');
  }
  requireCheck(isRecord(body), 'Invalid or locked login must return a generic problem object.');
  requireCheck(
    hasExactKeys(body, ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId']) &&
      body.type === 'about:blank' &&
      body.title === 'Request Error' &&
      body.status === 401 &&
      body.detail === 'Identifier atau password tidak valid.' &&
      body.instance === '/api/v1/auth/login' &&
      body.code === 'INVALID_CREDENTIALS' &&
      typeof body.requestId === 'string' &&
      body.requestId.length > 0,
    'Invalid or locked login must use the generic INVALID_CREDENTIALS response.',
  );
  requireCheck(
    secrets.every((secret) => secret.length > 0 && !response.body.includes(secret)),
    'Invalid or locked login must not echo fixture identifiers or passwords.',
  );
}

type AuditMutation = 'UPDATE' | 'DELETE';

function isExpectedAppendOnlyTriggerError(error: unknown, operation: AuditMutation): boolean {
  if (!isRecord(error)) return false;

  return (
    error.code === '55000' &&
    error.message === `audit_logs is append-only; ${operation} is not permitted`
  );
}

async function assertAppendOnlyTriggerCatalog(client: Client): Promise<void> {
  const result = await client.query<{
    schemaName: string;
    tableName: string;
    functionSchema: string;
    functionName: string;
    enabled: string;
    triggerType: number;
    isInternal: boolean;
  }>(`
    SELECT
      table_namespace.nspname AS "schemaName",
      table_relation.relname AS "tableName",
      function_namespace.nspname AS "functionSchema",
      trigger_function.proname AS "functionName",
      audit_trigger.tgenabled AS "enabled",
      audit_trigger.tgtype::integer AS "triggerType",
      audit_trigger.tgisinternal AS "isInternal"
    FROM pg_catalog.pg_trigger AS audit_trigger
    JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.oid = audit_trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.oid = audit_trigger.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    WHERE audit_trigger.tgname = 'audit_logs_reject_update_delete'
  `);

  const trigger = result.rows[0];
  requireCheck(
    result.rowCount === 1 &&
      trigger?.schemaName === 'public' &&
      trigger.tableName === 'audit_logs' &&
      trigger.functionSchema === 'public' &&
      trigger.functionName === 'reject_audit_log_mutation' &&
      (trigger.enabled === 'O' || trigger.enabled === 'A') &&
      trigger.triggerType === EXPECTED_UPDATE_DELETE_TRIGGER_TYPE &&
      trigger.isInternal === false,
    'The expected enabled BEFORE ROW UPDATE/DELETE append-only trigger must exist on public.audit_logs.',
  );
}

async function didAppendOnlyTriggerBlockMutation(
  client: Client,
  operation: AuditMutation,
  auditLogId: string,
): Promise<boolean> {
  let transactionStarted = false;
  let affectedRows: number | null = null;
  let mutationError: unknown;
  let rollbackFailed = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    try {
      const result =
        operation === 'UPDATE'
          ? await client.query('UPDATE public.audit_logs SET action = $1 WHERE id = $2::uuid', [
              'int005c_probe_update',
              auditLogId,
            ])
          : await client.query('DELETE FROM public.audit_logs WHERE id = $1::uuid', [auditLogId]);
      affectedRows = result.rowCount;
    } catch (error) {
      mutationError = error;
    }
  } catch (error) {
    mutationError = error;
  } finally {
    if (transactionStarted) {
      try {
        // Always roll back, including when the trigger is missing and the statement succeeds.
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
    }
  }

  requireCheck(
    !rollbackFailed,
    `The PostgreSQL ${operation} audit probe could not confirm rollback; no commit was attempted.`,
  );
  return affectedRows === null && isExpectedAppendOnlyTriggerError(mutationError, operation);
}

function isExpectedAttendanceAttemptUniqueError(error: unknown): boolean {
  if (!isRecord(error)) return false;

  return (
    error.code === '23505' && error.constraint === 'attendance_attempts_employee_idempotency_key'
  );
}

async function assertAttendanceAttemptIdempotencyConstraint(client: Client): Promise<void> {
  const employeeIds = [randomUUID(), randomUUID()];
  const deviceBindingIds = [randomUUID(), randomUUID()];
  const attemptIds = [randomUUID(), randomUUID(), randomUUID()];
  const idempotencyKey = randomUUID();
  const employeeNiks = [
    `int005d_${randomUUID().replaceAll('-', '')}`,
    `int005d_${randomUUID().replaceAll('-', '')}`,
  ];
  const deviceIdHashes = [
    `int005d_${randomUUID().replaceAll('-', '')}`,
    `int005d_${randomUUID().replaceAll('-', '')}`,
  ];

  let transactionStarted = false;
  let rollbackConfirmed = false;
  let setupSucceeded = true;
  let crossEmployeeKeyAccepted = false;
  let sameEmployeeDuplicateRejected = false;
  let sameEmployeeDuplicateAccepted = false;

  try {
    const begin = await client.query('BEGIN');
    transactionStarted = true;
    setupSucceeded = begin.command === 'BEGIN';

    if (setupSucceeded) {
      try {
        for (let index = 0; index < employeeIds.length; index += 1) {
          await client.query(
            `INSERT INTO public.employees ("id", "nik", "full_name")
             VALUES ($1::uuid, $2, $3)`,
            [employeeIds[index], employeeNiks[index], `INT-005D synthetic employee ${index + 1}`],
          );
          await client.query(
            `INSERT INTO public.device_bindings ("id", "employee_id", "device_id_hash", "device_name")
             VALUES ($1::uuid, $2::uuid, $3, $4)`,
            [
              deviceBindingIds[index],
              employeeIds[index],
              deviceIdHashes[index],
              'INT-005D synthetic device',
            ],
          );
        }

        const insertAttempt = async (attemptIndex: number, employeeIndex: number) =>
          client.query(
            `INSERT INTO public.attendance_attempts (
               "id", "employee_id", "device_binding_id", "type", "client_recorded_at",
               "network_status", "reported_method", "latitude", "longitude", "accuracy_meters",
               "selfie_reference_hash", "selfie_size_bytes", "liveness_face_detected_claim",
               "liveness_passed_claim", "idempotency_key", "request_fingerprint", "device_id_hash"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'CHECK_IN', $4::timestamptz,
               'ONLINE', 'GPS', 0, 0, 1,
               $5, 1, false, false, $6::uuid, $7, $8
             )`,
            [
              attemptIds[attemptIndex],
              employeeIds[employeeIndex],
              deviceBindingIds[employeeIndex],
              new Date(),
              randomBytes(32).toString('hex'),
              idempotencyKey,
              randomBytes(32).toString('hex'),
              deviceIdHashes[employeeIndex],
            ],
          );

        const firstEmployeeAttempt = await insertAttempt(0, 0);
        const secondEmployeeAttempt = await insertAttempt(1, 1);
        setupSucceeded =
          firstEmployeeAttempt.rowCount === 1 && secondEmployeeAttempt.rowCount === 1;
        crossEmployeeKeyAccepted = secondEmployeeAttempt.rowCount === 1;

        if (setupSucceeded) {
          try {
            const duplicateAttempt = await insertAttempt(2, 0);
            sameEmployeeDuplicateAccepted = duplicateAttempt.rowCount === 1;
          } catch (error) {
            sameEmployeeDuplicateRejected = isExpectedAttendanceAttemptUniqueError(error);
            if (!sameEmployeeDuplicateRejected) setupSucceeded = false;
          }
        }
      } catch {
        setupSucceeded = false;
      }
    }
  } catch {
    setupSucceeded = false;
  } finally {
    if (transactionStarted) {
      try {
        const rollback = await client.query('ROLLBACK');
        rollbackConfirmed = rollback.command === 'ROLLBACK';
      } catch {
        rollbackConfirmed = false;
      }
    }
  }

  requireCheck(
    rollbackConfirmed,
    'Attendance idempotency probe could not confirm transaction rollback; no commit was attempted.',
  );

  const persistedFixtures = await client.query<{
    employeeCount: number;
    deviceBindingCount: number;
    attendanceAttemptCount: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM public.employees WHERE "id" = ANY($1::uuid[])) AS "employeeCount",
       (SELECT count(*)::integer FROM public.device_bindings WHERE "id" = ANY($2::uuid[])) AS "deviceBindingCount",
       (SELECT count(*)::integer FROM public.attendance_attempts WHERE "id" = ANY($3::uuid[])) AS "attendanceAttemptCount"`,
    [employeeIds, deviceBindingIds, attemptIds],
  );
  const persisted = persistedFixtures.rows[0];
  requireCheck(
    persistedFixtures.rowCount === 1 &&
      persisted?.employeeCount === 0 &&
      persisted.deviceBindingCount === 0 &&
      persisted.attendanceAttemptCount === 0,
    'Attendance idempotency fixture rows must not persist after rollback.',
  );
  requireCheck(
    setupSucceeded &&
      crossEmployeeKeyAccepted &&
      sameEmployeeDuplicateRejected &&
      !sameEmployeeDuplicateAccepted,
    'The employee-scoped attendance idempotency unique index did not enforce the expected behavior.',
  );
}

type PromiseSettlement<T> = { settled: true; value: T } | { settled: false };

async function waitForPromiseSettlement<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PromiseSettlement<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<PromiseSettlement<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ settled: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertEphemeralSmokeClientIdentity(client: Client): Promise<void> {
  const identityResult = await client.query<{
    databaseName: string;
    userName: string;
  }>(`
    SELECT current_database() AS "databaseName", current_user AS "userName"
  `);
  const identity = identityResult.rows[0];
  requireCheck(
    identityResult.rowCount === 1 &&
      identity?.databaseName === EXPECTED_DATABASE_NAME &&
      identity.userName === EXPECTED_DATABASE_USER,
    'PostgreSQL idempotency probe connection must use the permitted ephemeral CI database and user.',
  );
}

async function assertConcurrentSmokeObserverCapability(observer: Client): Promise<void> {
  const capability = await observer.query<{ canInspectBlockingPids: boolean }>(`
    SELECT has_function_privilege(
      current_user,
      'pg_catalog.pg_blocking_pids(integer)',
      'EXECUTE'
    ) AS "canInspectBlockingPids"
  `);
  requireCheck(
    capability.rowCount === 1 && capability.rows[0]?.canInspectBlockingPids === true,
    'The ephemeral PostgreSQL role must be allowed to observe lock blockers before the concurrency probe.',
  );
}

async function waitForIdempotencyConflictBlock(
  observer: Client,
  firstBackendPid: number,
  secondBackendPid: number,
  secondApplicationName: string,
): Promise<boolean> {
  const deadline = Date.now() + POSTGRES_PROBE_TIMEOUT_MS;
  do {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT $1::integer = ANY(pg_blocking_pids(activity.pid)) AS "blocked"
       FROM pg_stat_activity AS activity
       WHERE activity.pid = $2::integer
         AND activity.application_name = $3
         AND activity.datname = current_database()
         AND activity.usename = current_user
         AND activity.state = 'active'`,
      [firstBackendPid, secondBackendPid, secondApplicationName],
    );
    if (result.rows[0]?.blocked === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);

  return false;
}

async function isPostgresBackendPresent(
  observer: Client,
  backendPid: number,
  applicationName: string,
): Promise<boolean> {
  const result = await observer.query<{
    applicationName: string;
    databaseName: string;
    userName: string;
  }>(
    `SELECT application_name AS "applicationName", datname AS "databaseName", usename AS "userName"
     FROM pg_stat_activity
     WHERE pid = $1::integer`,
    [backendPid],
  );
  const backend = result.rows[0];
  return (
    result.rowCount === 1 &&
    backend?.applicationName === applicationName &&
    backend.databaseName === EXPECTED_DATABASE_NAME &&
    backend.userName === EXPECTED_DATABASE_USER
  );
}

async function assertConcurrentAttendanceAttemptIdempotencyConstraint(
  databaseUrl: string,
): Promise<void> {
  const employeeId = randomUUID();
  const deviceBindingId = randomUUID();
  const attemptIds = [randomUUID(), randomUUID()];
  const idempotencyKey = randomUUID();
  const employeeNik = `int005h_${randomUUID().replaceAll('-', '')}`;
  const deviceIdHash = `int005h_${randomUUID().replaceAll('-', '')}`;
  const secondApplicationName = `int005h_${randomUUID().replaceAll('-', '')}`;
  const firstClient = new Client({ connectionString: databaseUrl });
  const secondClient = new Client({
    connectionString: databaseUrl,
    application_name: secondApplicationName,
  });
  const fixtureClient = new Client({ connectionString: databaseUrl });
  const connectedClients: Client[] = [];

  let fixtureTransactionOpen = false;
  let firstTransactionOpen = false;
  let secondTransactionOpen = false;
  let fixtureClientIdentityVerified = false;
  let secondBackendPid: number | null = null;
  let secondAttemptOutcome:
    | Promise<{ kind: 'success'; rowCount: number | null } | { kind: 'error'; error: unknown }>
    | undefined;
  let firstCommitted = false;
  let probeSucceeded = false;
  let teardownSafe = true;
  let fixtureCleanupConfirmed = false;

  try {
    for (const client of [fixtureClient, firstClient, secondClient]) {
      await client.connect();
      connectedClients.push(client);
      await assertEphemeralSmokeClientIdentity(client);
      if (client === fixtureClient) fixtureClientIdentityVerified = true;
    }
    await assertConcurrentSmokeObserverCapability(fixtureClient);

    fixtureTransactionOpen = true;
    const setup = await fixtureClient.query('BEGIN');
    requireCheck(setup.command === 'BEGIN', 'Idempotency race fixture transaction did not start.');
    await fixtureClient.query(
      `INSERT INTO public.employees ("id", "nik", "full_name")
       VALUES ($1::uuid, $2, $3)`,
      [employeeId, employeeNik, 'INT-005H synthetic employee'],
    );
    await fixtureClient.query(
      `INSERT INTO public.device_bindings ("id", "employee_id", "device_id_hash", "device_name")
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [deviceBindingId, employeeId, deviceIdHash, 'INT-005H synthetic device'],
    );
    const fixtureCommit = await fixtureClient.query('COMMIT');
    fixtureTransactionOpen = false;
    requireCheck(
      fixtureCommit.command === 'COMMIT',
      'Idempotency race fixture transaction could not confirm commit.',
    );

    firstTransactionOpen = true;
    const firstBegin = await firstClient.query('BEGIN');
    requireCheck(
      firstBegin.command === 'BEGIN',
      'First idempotency race transaction did not start.',
    );
    const firstPidResult = await firstClient.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS "pid"',
    );
    const firstBackendPid = firstPidResult.rows[0]?.pid;
    requireCheck(
      firstPidResult.rowCount === 1 &&
        Number.isSafeInteger(firstBackendPid) &&
        firstBackendPid! > 0,
      'First idempotency race backend identity could not be confirmed.',
    );

    const insertAttemptSql = `INSERT INTO public.attendance_attempts (
         "id", "employee_id", "device_binding_id", "type", "client_recorded_at",
         "network_status", "reported_method", "latitude", "longitude", "accuracy_meters",
         "selfie_reference_hash", "selfie_size_bytes", "liveness_face_detected_claim",
         "liveness_passed_claim", "idempotency_key", "request_fingerprint", "device_id_hash"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'CHECK_IN', $4::timestamptz,
         'ONLINE', 'GPS', 0, 0, 1,
         $5, 1, false, false, $6::uuid, $7, $8
       )`;
    const attemptValues = (attemptId: string) => [
      attemptId,
      employeeId,
      deviceBindingId,
      new Date(),
      randomBytes(32).toString('hex'),
      idempotencyKey,
      randomBytes(32).toString('hex'),
      deviceIdHash,
    ];

    const firstInsert = await firstClient.query(insertAttemptSql, attemptValues(attemptIds[0]!));
    requireCheck(firstInsert.rowCount === 1, 'First idempotency race attempt was not inserted.');

    secondTransactionOpen = true;
    const secondBegin = await secondClient.query('BEGIN');
    requireCheck(
      secondBegin.command === 'BEGIN',
      'Second idempotency race transaction did not start.',
    );
    const secondPidResult = await secondClient.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS "pid"',
    );
    secondBackendPid = secondPidResult.rows[0]?.pid ?? null;
    requireCheck(
      secondPidResult.rowCount === 1 &&
        Number.isSafeInteger(secondBackendPid) &&
        secondBackendPid! > 0 &&
        secondBackendPid !== firstBackendPid,
      'The two idempotency race inserts must use distinct PostgreSQL sessions.',
    );

    secondAttemptOutcome = secondClient
      .query(insertAttemptSql, attemptValues(attemptIds[1]!))
      .then((result) => ({ kind: 'success' as const, rowCount: result.rowCount }))
      .catch((error: unknown) => ({ kind: 'error' as const, error }));

    const conflictWasObserved = await waitForIdempotencyConflictBlock(
      fixtureClient,
      firstBackendPid!,
      secondBackendPid!,
      secondApplicationName,
    );
    requireCheck(
      conflictWasObserved,
      'PostgreSQL did not confirm that the second idempotency insert waited on the first transaction.',
    );

    const firstCommit = await firstClient.query('COMMIT');
    firstTransactionOpen = false;
    firstCommitted = firstCommit.command === 'COMMIT';
    requireCheck(firstCommitted, 'First idempotency race attempt could not confirm commit.');

    const secondOutcome = await waitForPromiseSettlement(
      secondAttemptOutcome,
      POSTGRES_PROBE_TIMEOUT_MS,
    );
    requireCheck(
      secondOutcome.settled,
      'Second idempotency race insert did not settle after its blocker committed.',
    );
    requireCheck(
      secondOutcome.value.kind === 'error' &&
        isExpectedAttendanceAttemptUniqueError(secondOutcome.value.error),
      'Concurrent duplicate must fail with SQLSTATE 23505 and the exact employee idempotency index.',
    );

    const secondRollback = await secondClient.query('ROLLBACK');
    secondTransactionOpen = false;
    requireCheck(
      secondRollback.command === 'ROLLBACK',
      'Second idempotency race transaction could not confirm rollback.',
    );

    const persistedWinner = await fixtureClient.query<{ id: string }>(
      `SELECT "id" FROM public.attendance_attempts
       WHERE "employee_id" = $1::uuid AND "idempotency_key" = $2::uuid
       ORDER BY "id"`,
      [employeeId, idempotencyKey],
    );
    requireCheck(
      persistedWinner.rowCount === 1 && persistedWinner.rows[0]?.id === attemptIds[0],
      'Exactly the first committed attendance attempt must persist after the duplicate race.',
    );
    probeSucceeded = true;
  } finally {
    if (fixtureTransactionOpen) {
      try {
        const result = await fixtureClient.query('ROLLBACK');
        fixtureTransactionOpen = result.command !== 'ROLLBACK';
      } catch {
        teardownSafe = false;
      }
    }

    if (firstTransactionOpen) {
      try {
        const result = await firstClient.query('ROLLBACK');
        firstTransactionOpen = result.command !== 'ROLLBACK';
      } catch {
        teardownSafe = false;
      }
    }

    if (secondAttemptOutcome && secondBackendPid !== null) {
      const settled = await waitForPromiseSettlement(
        secondAttemptOutcome,
        POSTGRES_PROBE_TIMEOUT_MS,
      );
      if (!settled.settled) {
        // Rolling back session A above releases its unique-index lock before we inspect or
        // clean up any committed synthetic fixture, so the second insert can safely finish.
        try {
          const backendStillPresent = await isPostgresBackendPresent(
            fixtureClient,
            secondBackendPid,
            secondApplicationName,
          );
          if (backendStillPresent) {
            const terminated = await fixtureClient.query<{ terminated: boolean }>(
              'SELECT pg_terminate_backend($1::integer, 5000) AS "terminated"',
              [secondBackendPid],
            );
            const backendRemains = await isPostgresBackendPresent(
              fixtureClient,
              secondBackendPid,
              secondApplicationName,
            );
            if (terminated.rowCount !== 1 || backendRemains) {
              teardownSafe = false;
            }
          }
        } catch {
          teardownSafe = false;
        }
      }

      const finalSettlement = await waitForPromiseSettlement(
        secondAttemptOutcome,
        POSTGRES_PROBE_TIMEOUT_MS,
      );
      if (!finalSettlement.settled) teardownSafe = false;
    }

    if (secondTransactionOpen && connectedClients.includes(secondClient)) {
      try {
        const result = await secondClient.query('ROLLBACK');
        secondTransactionOpen = result.command !== 'ROLLBACK';
      } catch {
        try {
          const backendPresent =
            secondBackendPid === null ||
            (await isPostgresBackendPresent(
              fixtureClient,
              secondBackendPid,
              secondApplicationName,
            ));
          if (backendPresent) teardownSafe = false;
          else secondTransactionOpen = false;
        } catch {
          teardownSafe = false;
        }
      }
    }

    if (firstTransactionOpen || secondTransactionOpen || fixtureTransactionOpen) {
      teardownSafe = false;
    }

    if (teardownSafe && fixtureClientIdentityVerified && connectedClients.includes(fixtureClient)) {
      let cleanupTransactionOpen = false;
      try {
        cleanupTransactionOpen = true;
        const begin = await fixtureClient.query('BEGIN');
        requireCheck(
          begin.command === 'BEGIN',
          'Synthetic fixture cleanup transaction did not start.',
        );
        const deletedAttempts = await fixtureClient.query(
          'DELETE FROM public.attendance_attempts WHERE "id" = ANY($1::uuid[])',
          [attemptIds],
        );
        const deletedDevice = await fixtureClient.query(
          'DELETE FROM public.device_bindings WHERE "id" = $1::uuid',
          [deviceBindingId],
        );
        const deletedEmployee = await fixtureClient.query(
          'DELETE FROM public.employees WHERE "id" = $1::uuid',
          [employeeId],
        );
        requireCheck(
          (deletedAttempts.rowCount ?? 0) <= attemptIds.length &&
            (!probeSucceeded || (deletedAttempts.rowCount ?? 0) === 1) &&
            (deletedDevice.rowCount ?? 0) <= 1 &&
            (deletedEmployee.rowCount ?? 0) <= 1,
          'Synthetic fixture cleanup affected an unexpected number of rows.',
        );
        const commit = await fixtureClient.query('COMMIT');
        cleanupTransactionOpen = false;
        requireCheck(
          commit.command === 'COMMIT',
          'Synthetic fixture cleanup commit was not confirmed.',
        );
        const remaining = await fixtureClient.query<{ count: number }>(
          `SELECT count(*)::integer AS "count"
           FROM public.attendance_attempts
           WHERE "employee_id" = $1::uuid OR "device_binding_id" = $2::uuid OR "id" = ANY($3::uuid[])`,
          [employeeId, deviceBindingId, attemptIds],
        );
        const remainingBindings = await fixtureClient.query<{ count: number }>(
          'SELECT count(*)::integer AS "count" FROM public.device_bindings WHERE "id" = $1::uuid',
          [deviceBindingId],
        );
        const remainingEmployees = await fixtureClient.query<{ count: number }>(
          'SELECT count(*)::integer AS "count" FROM public.employees WHERE "id" = $1::uuid',
          [employeeId],
        );
        fixtureCleanupConfirmed =
          remaining.rows[0]?.count === 0 &&
          remainingBindings.rows[0]?.count === 0 &&
          remainingEmployees.rows[0]?.count === 0;
      } catch {
        if (cleanupTransactionOpen) {
          try {
            const rollback = await fixtureClient.query('ROLLBACK');
            if (rollback.command !== 'ROLLBACK') teardownSafe = false;
          } catch {
            teardownSafe = false;
          }
        }
        fixtureCleanupConfirmed = false;
      }
    }

    await Promise.all(
      connectedClients.map(async (client) => {
        try {
          await client.end();
        } catch {
          teardownSafe = false;
        }
      }),
    );
  }

  requireCheck(
    teardownSafe && fixtureCleanupConfirmed && probeSucceeded && firstCommitted,
    'Concurrent attendance idempotency probe, transaction teardown, or synthetic fixture cleanup failed.',
  );
}

async function runPostgresSmoke(databaseUrl: string): Promise<void> {
  const [
    { Prisma },
    { AccountStatus, UserRole },
    { buildApp },
    { createPrismaClient },
    { createDatabaseReadinessProbe },
    { AuditService },
    { argon2PasswordHasher, createArgon2AuthService },
    { PrismaAuditLogRepository, PrismaAuthRepository },
    { createConsentPolicyProvider, ConsentService, hashConsentPolicyText },
    { PrismaConsentRepository },
    { PrismaAttendanceAttemptRepository },
    { AttendanceAttemptService },
    { DeviceBindingService },
    { PrismaDeviceBindingRepository },
    { MonthlyReportService },
    { PrismaMonthlyReportRepository },
    { AppError },
    { getBusinessDateAndWeekday },
  ] = await Promise.all([
    import('../src/generated/prisma/client.js'),
    import('../src/generated/prisma/enums.js'),
    import('../src/app.js'),
    import('../src/db/prisma.js'),
    import('../src/db/readiness.js'),
    import('../src/modules/audit/index.js'),
    import('../src/modules/auth/argon2.js'),
    import('../src/modules/auth/prisma-repository.js'),
    import('../src/modules/consent/index.js'),
    import('../src/modules/consent/prisma-repository.js'),
    import('../src/modules/attendance/prisma-repository.js'),
    import('../src/modules/attendance/index.js'),
    import('../src/modules/device-binding/index.js'),
    import('../src/modules/device-binding/prisma-repository.js'),
    import('../src/modules/report/index.js'),
    import('../src/modules/report/prisma-repository.js'),
    import('../src/errors/app-error.js'),
    import('../src/modules/time/index.js'),
  ]);

  const prisma = createPrismaClient(databaseUrl);
  const fixtureAccountId = randomUUID();
  const fixtureUsername = `int005b_${fixtureAccountId.replaceAll('-', '')}`;
  const fixturePassword = randomBytes(32).toString('base64url');
  const consentPolicyVersion = `ci-only-int-005i-${randomUUID()}`;
  const consentPolicyText =
    'Synthetic CI-only consent policy for PostgreSQL integration smoke tests. Not company policy; never use in production.';
  const lockoutFixtureAccountId = randomUUID();
  const lockoutFixtureUsername = `int005e_${lockoutFixtureAccountId.replaceAll('-', '')}`;
  const lockoutFixturePassword = randomBytes(32).toString('base64url');
  const incorrectLockoutPassword = randomBytes(32).toString('base64url');
  const createdFixtureAccountIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const auditProbeClient = new Client({ connectionString: databaseUrl });
  let auditProbeConnected = false;
  let syntheticEvidenceFixture: Readonly<{
    referenceId: string;
    employeeId: string;
    deviceBindingId: string;
    stagedObjectKey: string;
    sealedObjectKey: string;
    sizeBytes: number;
  }> | null = null;
  let evidenceVerifierInvocations = 0;
  const evidenceVerifier: AttendanceEvidenceReferenceVerifier = {
    async verifyPrivateSelfieReference(input) {
      evidenceVerifierInvocations += 1;
      const expected = syntheticEvidenceFixture;
      if (
        !expected ||
        input.referenceId !== expected.referenceId ||
        input.employeeId !== expected.employeeId ||
        input.deviceBindingId !== expected.deviceBindingId
      ) {
        throw new AppError(
          422,
          'ATTENDANCE_EVIDENCE_INVALID',
          'Referensi bukti absensi tidak valid.',
        );
      }
      return {
        sizeBytes: expected.sizeBytes,
        stagedObjectKey: expected.stagedObjectKey,
        sealedObjectKey: expected.sealedObjectKey,
      };
    },
  };
  const readEvidenceVerifierInvocations = (): number => evidenceVerifierInvocations;
  const assertAuthenticatedAttendanceAttemptHttpSmoke = async (
    consentRepository: InstanceType<typeof PrismaConsentRepository>,
    audit: InstanceType<typeof AuditService>,
  ): Promise<void> => {
    const fixtureId = randomUUID();
    const employeeAccountId = randomUUID();
    const employeeUsername = 'int005i_' + fixtureId.replaceAll('-', '');
    const employeePassword = randomBytes(32).toString('base64url');
    const deviceToken = randomBytes(32).toString('base64url');
    await prisma.userAccount.create({
      data: {
        id: employeeAccountId,
        username: employeeUsername,
        passwordHash: await argon2PasswordHasher.hash(employeePassword),
        role: UserRole.EMPLOYEE,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      },
    });
    createdFixtureAccountIds.push(employeeAccountId);

    // Keep this synthetic fixture until disposable CI database teardown. The real
    // repository appends immutable audit rows, so cleanup could trigger a forbidden
    // audit_logs mutation through foreign-key actions.
    const employeeId = randomUUID();
    const deviceBindingId = randomUUID();
    const storeId = randomUUID();
    const workShiftId = randomUUID();
    const shiftAssignmentId = randomUUID();
    const deviceIdHash = createHash('sha256').update(deviceToken, 'ascii').digest('hex');
    const employee = await prisma.employee.create({
      data: {
        id: employeeId,
        accountId: employeeAccountId,
        nik: 'CI-SMOKE-' + fixtureId,
        fullName: 'CI Smoke Employee ' + fixtureId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const businessDay = getBusinessDateAndWeekday(new Date(), 'Asia/Jakarta');
    const businessDate = new Date(businessDay.businessDate + 'T00:00:00.000Z');
    const latitude = randomInt(-60_000_000, 60_000_001) / 1_000_000;
    const longitude = randomInt(-180_000_000, 180_000_001) / 1_000_000;
    const store = await prisma.store.create({
      data: {
        id: storeId,
        name: 'CI Smoke Store ' + fixtureId,
        latitude,
        longitude,
        radiusMeters: 10,
        accuracyLimitMeters: 30,
        isActive: true,
      },
      select: { id: true, radiusMeters: true, accuracyLimitMeters: true },
    });
    await prisma.employeeStore.create({
      data: { employeeId: employee.id, storeId: store.id },
    });
    await prisma.deviceBinding.create({
      data: {
        id: deviceBindingId,
        employeeId: employee.id,
        deviceIdHash,
        deviceName: 'CI smoke synthetic device ' + fixtureId,
        status: 'APPROVED',
        approvedByUserAccountId: fixtureAccountId,
        approvedAt: new Date(),
      },
    });
    await prisma.workShift.create({
      data: {
        id: workShiftId,
        name: 'CI Smoke Shift ' + fixtureId,
        startTime: new Date(Date.UTC(1970, 0, 1, 0, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 23, 59)),
        breakMinutes: 0,
        lateToleranceMinutes: 0,
        // Include the current Jakarta weekday and its successor for a midnight rollover.
        workDays: [businessDay.weekday, (businessDay.weekday % 7) + 1],
        isActive: true,
      },
    });
    await prisma.shiftAssignment.create({
      data: {
        id: shiftAssignmentId,
        employeeId: employee.id,
        workShiftId,
        storeId: store.id,
        assignedByUserAccountId: fixtureAccountId,
        effectiveFrom: businessDate,
      },
    });
    const selfieReferenceId = randomUUID();
    const referenceHash = createHash('sha256').update(selfieReferenceId, 'utf8').digest('hex');
    const stagedObjectKey = 'ci-smoke/staged/' + randomUUID();
    const sealedObjectKey = 'ci-smoke/sealed/' + randomUUID();
    const selfieSizeBytes = 1_024;
    const intentExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.selfieUploadIntent.create({
      data: {
        referenceHash,
        employeeId: employee.id,
        deviceBindingId,
        objectKey: stagedObjectKey,
        stagingObjectKey: stagedObjectKey,
        sealedObjectKey,
        contentType: 'image/jpeg',
        declaredSizeBytes: selfieSizeBytes,
        status: 'PENDING',
        expiresAt: intentExpiresAt,
      },
    });
    syntheticEvidenceFixture = {
      referenceId: selfieReferenceId,
      employeeId: employee.id,
      deviceBindingId,
      stagedObjectKey,
      sealedObjectKey,
      sizeBytes: selfieSizeBytes,
    };
    const now = new Date();
    const attemptPayload = {
      idempotencyKey: randomUUID(),
      storeId: store.id,
      type: 'CHECK_IN',
      clientRecordedAt: now.toISOString(),
      networkStatus: 'ONLINE',
      location: { latitude, longitude, accuracyMeters: 5 },
      validationMethod: 'GPS',
      selfie: { blob: selfieReferenceId, sizeKb: selfieSizeBytes / 1_024 },
      liveness: { faceDetected: true, passed: true },
    };
    const noSession = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: { origin: ALLOWED_ORIGIN },
      payload: attemptPayload,
    });
    requireCheck(
      noSession.statusCode === 401 &&
        isRecord(noSession.json()) &&
        noSession.json().code === 'UNAUTHENTICATED' &&
        noSession.headers['cache-control'] === 'no-store',
      'POST /api/v1/attendance/attempts must reject an unauthenticated request without caching it.',
    );
    requireCheck(
      (await prisma.attendanceAttempt.count({ where: { employeeId: employee.id } })) === 0 &&
        readEvidenceVerifierInvocations() === 0,
      'An unauthenticated request must not reach evidence verification or persist an attendance attempt.',
    );

    const login = await app!.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: {
        identifier: employeeUsername,
        password: employeePassword,
        deviceToken,
        deviceName: 'CI smoke synthetic device ' + fixtureId,
      },
    });
    requireCheck(
      login.statusCode === 200,
      `Synthetic Employee login must return HTTP 200 (received ${login.statusCode}).`,
    );
    assertPublicAuthResponse(
      login.json(),
      { id: employeeAccountId, username: employeeUsername },
      { role: 'EMPLOYEE', employeeId: employee.id, deviceBindingStatus: 'APPROVED' },
    );
    const employeeLoginBody = login.json();
    requireCheck(
      isRecord(employeeLoginBody) &&
        isRecord(employeeLoginBody.user) &&
        employeeLoginBody.user.role === UserRole.EMPLOYEE &&
        employeeLoginBody.user.employeeId === employee.id &&
        employeeLoginBody.user.deviceBindingStatus === 'APPROVED',
      'The authenticated account must be the active synthetic Employee with its approved device binding.',
    );
    const employeeSessionCookie = readSignedSessionCookie(
      login.headers['set-cookie'],
      app!,
      requireCheck,
    );
    const employeeSessions = await prisma.session.findMany({
      where: { userAccountId: employeeAccountId },
      select: { deviceBindingId: true, revokedAt: true },
    });
    requireCheck(
      employeeSessions.length === 1 &&
        employeeSessions[0]?.deviceBindingId === deviceBindingId &&
        employeeSessions[0]?.revokedAt === null,
      'Employee login must persist one active PostgreSQL session bound to the approved synthetic device.',
    );
    requireCheck(
      (await consentRepository.findLatestForAccount(employeeAccountId)) === null,
      'The Employee consent gate must be pending before the synthetic policy is accepted.',
    );

    const consentBlocked = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: attemptPayload,
    });
    requireCheck(
      consentBlocked.statusCode === 403 &&
        isRecord(consentBlocked.json()) &&
        consentBlocked.json().code === 'CONSENT_REQUIRED' &&
        consentBlocked.headers['cache-control'] === 'no-store',
      'The real authenticated attendance route must reject an Employee who has not accepted consent.',
    );
    const pendingIntent = await prisma.selfieUploadIntent.findUnique({
      where: { referenceHash },
      select: { status: true, attachedAttemptId: true },
    });
    requireCheck(
      (await prisma.attendanceAttempt.count({ where: { employeeId: employee.id } })) === 0 &&
        pendingIntent?.status === 'PENDING' &&
        pendingIntent.attachedAttemptId === null &&
        readEvidenceVerifierInvocations() === 0,
      'A consent-blocked request must not create an attempt, verify evidence, or consume its selfie intent.',
    );

    const currentConsent = await app!.inject({
      method: 'GET',
      url: '/api/v1/consents/current',
      headers: { cookie: employeeSessionCookie.cookie },
    });
    const currentConsentBody = currentConsent.json();
    requireCheck(
      currentConsent.statusCode === 200 &&
        currentConsent.headers['cache-control'] === 'no-store' &&
        isRecord(currentConsentBody) &&
        currentConsentBody.consentRequired === true &&
        isRecord(currentConsentBody.policy) &&
        currentConsentBody.policy.version === consentPolicyVersion &&
        currentConsentBody.policy.text === consentPolicyText,
      'The Employee must receive the explicitly synthetic CI-only consent policy before acceptance.',
    );
    const consentAcceptance = await app!.inject({
      method: 'POST',
      url: '/api/v1/consents',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: { policyVersion: consentPolicyVersion, accepted: true },
    });
    const consentAcceptanceBody = consentAcceptance.json();
    requireCheck(
      consentAcceptance.statusCode === 200 &&
        consentAcceptance.headers['cache-control'] === 'no-store' &&
        isRecord(consentAcceptanceBody) &&
        consentAcceptanceBody.policyVersion === consentPolicyVersion &&
        consentAcceptanceBody.alreadyAccepted === false &&
        typeof consentAcceptanceBody.acceptedAt === 'string',
      'The Employee must accept the synthetic CI-only policy through the real consent HTTP route.',
    );
    const persistedConsent = await consentRepository.findLatestForAccount(employeeAccountId);
    requireCheck(
      persistedConsent !== null &&
        persistedConsent.employeeId === employee.id &&
        persistedConsent.policyVersion === consentPolicyVersion &&
        persistedConsent.consentTextHash === hashConsentPolicyText(consentPolicyText) &&
        persistedConsent.withdrawnAt === null,
      'Consent acceptance must persist a current PostgreSQL record linked to the synthetic Employee.',
    );
    const acceptedMe = await app!.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: employeeSessionCookie.cookie },
    });
    requireCheck(
      acceptedMe.statusCode === 200 &&
        isRecord(acceptedMe.json()) &&
        acceptedMe.json().consentRequired === false,
      'The real signed session cookie must observe the persisted consent acceptance.',
    );

    const invalidReference = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: {
        ...attemptPayload,
        selfie: { ...attemptPayload.selfie, blob: randomUUID() },
      },
    });
    requireCheck(
      invalidReference.statusCode === 422 &&
        isRecord(invalidReference.json()) &&
        invalidReference.json().code === 'ATTENDANCE_EVIDENCE_INVALID',
      'The CI-only evidence verifier must reject any reference other than this synthetic fixture.',
    );
    const invalidSize = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: {
        ...attemptPayload,
        selfie: { ...attemptPayload.selfie, sizeKb: 2 },
      },
    });
    requireCheck(
      invalidSize.statusCode === 422 &&
        isRecord(invalidSize.json()) &&
        invalidSize.json().code === 'ATTENDANCE_EVIDENCE_INVALID' &&
        (await prisma.attendanceAttempt.count({ where: { employeeId: employee.id } })) === 0,
      'The CI-only verifier must reject a selfie size that does not match its synthetic 1 KiB object.',
    );
    const unconsumedIntent = await prisma.selfieUploadIntent.findUnique({
      where: { referenceHash },
      select: { status: true, attachedAttemptId: true },
    });
    requireCheck(
      unconsumedIntent?.status === 'PENDING' &&
        unconsumedIntent.attachedAttemptId === null &&
        readEvidenceVerifierInvocations() === 2,
      'Rejected evidence must leave the single synthetic upload intent pending and unconsumed.',
    );

    const attemptResponse = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: attemptPayload,
    });
    const receipt = attemptResponse.json();
    requireCheck(
      attemptResponse.statusCode === 202 &&
        attemptResponse.headers['cache-control'] === 'no-store' &&
        isRecord(receipt) &&
        hasExactKeys(receipt, [
          'attemptId',
          'attendanceId',
          'receivedAt',
          'replayed',
          'state',
          'type',
          'validationStatus',
        ]) &&
        receipt.state === 'RECORDED' &&
        receipt.type === 'CHECK_IN' &&
        receipt.replayed === false &&
        typeof receipt.attemptId === 'string' &&
        typeof receipt.attendanceId === 'string' &&
        receipt.validationStatus === 'PENDING_VERIFICATION' &&
        typeof receipt.receivedAt === 'string' &&
        !Number.isNaN(Date.parse(receipt.receivedAt)),
      'Authenticated POST /api/v1/attendance/attempts must return the uncached RECORDED receipt contract.',
    );
    const attemptId = receipt.attemptId as string;
    const attendanceId = receipt.attendanceId as string;
    requireCheck(
      readEvidenceVerifierInvocations() === 3,
      'Only the rejected-reference, rejected-size, and one valid synthetic selfie may reach the deterministic CI verifier.',
    );
    const replay = await app!.inject({
      method: 'POST',
      url: '/api/v1/attendance/attempts',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: employeeSessionCookie.cookie,
      },
      payload: attemptPayload,
    });
    const replayReceipt = replay.json();
    requireCheck(
      replay.statusCode === 200 &&
        replay.headers['cache-control'] === 'no-store' &&
        isRecord(replayReceipt) &&
        replayReceipt.attemptId === attemptId &&
        replayReceipt.attendanceId === attendanceId &&
        replayReceipt.state === 'RECORDED' &&
        replayReceipt.replayed === true &&
        readEvidenceVerifierInvocations() === 3,
      'An identical HTTP retry must replay the same receipt without consuming or verifying the selfie intent again.',
    );
    requireCheck(
      (await prisma.attendanceAttempt.count({ where: { employeeId: employee.id } })) === 1 &&
        (await prisma.attendance.count({ where: { sourceAttemptId: attemptId } })) === 1,
      'The successful HTTP request and its retry must persist exactly one attempt and one linked attendance row.',
    );

    const persisted = await prisma.attendanceAttempt.findUnique({
      where: { id: attemptId },
      select: {
        employeeId: true,
        deviceBindingId: true,
        deviceIdHash: true,
        processingStatus: true,
        processingErrorCode: true,
        geofenceResult: true,
        storeId: true,
        distanceMeters: true,
        geofenceRadiusMeters: true,
        accuracyLimitMeters: true,
        attendance: {
          select: {
            id: true,
            employeeId: true,
            sourceAttemptId: true,
            workDate: true,
            storeId: true,
            shiftAssignmentId: true,
            selfieCapture: {
              select: {
                objectKey: true,
                contentType: true,
                sizeBytes: true,
                faceDetected: true,
                livenessPassed: true,
              },
            },
            locationProof: {
              select: {
                latitude: true,
                longitude: true,
                accuracyMeters: true,
                distanceMeters: true,
                isMocked: true,
                source: true,
              },
            },
          },
        },
        selfieUploadIntent: {
          select: {
            referenceHash: true,
            employeeId: true,
            deviceBindingId: true,
            objectKey: true,
            sealedObjectKey: true,
            status: true,
            attachedAttemptId: true,
          },
        },
      },
    });
    requireCheck(
      persisted !== null &&
        persisted.employeeId === employee.id &&
        persisted.deviceBindingId === deviceBindingId &&
        persisted.deviceIdHash === deviceIdHash &&
        persisted.processingStatus === 'RECORDED' &&
        persisted.processingErrorCode === null &&
        persisted.geofenceResult === 'WITHIN_LIMITS' &&
        persisted.storeId === store.id &&
        persisted.distanceMeters !== null &&
        Number(persisted.distanceMeters) === 0 &&
        persisted.geofenceRadiusMeters === store.radiusMeters &&
        persisted.accuracyLimitMeters === store.accuracyLimitMeters,
      'Prisma must persist the employee/device-bound attempt and its within-geofence store assessment.',
    );
    requireCheck(
      persisted.attendance !== null &&
        persisted.attendance.id === attendanceId &&
        persisted.attendance.employeeId === employee.id &&
        persisted.attendance.sourceAttemptId === attemptId &&
        persisted.attendance.storeId === store.id &&
        persisted.attendance.shiftAssignmentId === shiftAssignmentId &&
        persisted.attendance.selfieCapture !== null &&
        persisted.attendance.locationProof !== null &&
        persisted.attendance.selfieCapture.objectKey === sealedObjectKey &&
        persisted.attendance.selfieCapture.contentType === 'image/jpeg' &&
        persisted.attendance.selfieCapture.sizeBytes === 1_024 &&
        Number(persisted.attendance.locationProof.latitude) === latitude &&
        Number(persisted.attendance.locationProof.longitude) === longitude &&
        Number(persisted.attendance.locationProof.accuracyMeters) === 5 &&
        Number(persisted.attendance.locationProof.distanceMeters) === 0 &&
        !persisted.attendance.locationProof.isMocked &&
        persisted.attendance.locationProof.source === 'GPS',
      'Prisma must persist the linked attendance row for the active shift/store with sealed selfie and matching GPS evidence.',
    );
    requireCheck(
      persisted.selfieUploadIntent?.referenceHash === referenceHash &&
        persisted.selfieUploadIntent.employeeId === employee.id &&
        persisted.selfieUploadIntent.deviceBindingId === deviceBindingId &&
        persisted.selfieUploadIntent.objectKey === sealedObjectKey &&
        persisted.selfieUploadIntent.sealedObjectKey === null &&
        persisted.selfieUploadIntent.status === 'ATTACHED' &&
        persisted.selfieUploadIntent.attachedAttemptId === attemptId,
      'The PENDING selfie intent must be consumed once and linked to the RECORDED attempt.',
    );

    const workDate = persisted.attendance.workDate;
    const workDateString = workDate.toISOString().slice(0, 10);
    const workDateUtc = new Date(`${workDateString}T00:00:00.000Z`);
    const workDay = workDateUtc.getUTCDay() || 7;
    const secondWorkShiftId = randomUUID();
    const secondShiftAssignmentId = randomUUID();

    // Bound both synthetic assignments to this exact persisted attendance date so
    // future NOT_STARTED schedule rows cannot obscure the two-shift workDays case.
    await prisma.shiftAssignment.update({
      where: { id: shiftAssignmentId },
      data: { effectiveTo: workDate },
    });
    await prisma.workShift.create({
      data: {
        id: secondWorkShiftId,
        name: 'CI Smoke Second Shift ' + fixtureId,
        startTime: new Date(Date.UTC(1970, 0, 1, 12, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 20, 0)),
        breakMinutes: 0,
        lateToleranceMinutes: 0,
        workDays: [workDay],
        isActive: true,
      },
    });
    await prisma.shiftAssignment.create({
      data: {
        id: secondShiftAssignmentId,
        employeeId: employee.id,
        workShiftId: secondWorkShiftId,
        storeId: store.id,
        assignedByUserAccountId: fixtureAccountId,
        effectiveFrom: workDate,
        effectiveTo: workDate,
      },
    });

    const monthlyReportService = new MonthlyReportService(
      new PrismaMonthlyReportRepository(prisma),
      audit,
      undefined,
      () => new Date(),
      'Asia/Jakarta',
    );
    const monthlyReport = await monthlyReportService.monthlyReport(
      {
        userAccountId: fixtureAccountId,
        role: UserRole.ADMIN,
        username: employeeUsername,
        employeeId: null,
        deviceBindingId: null,
        deviceBindingStatus: null,
        mustChangePassword: false,
        consentRequired: false,
        sessionId: `ci-smoke-monthly-report-${fixtureId}`,
        lastSeenAt: new Date(),
      },
      { month: workDateString.slice(0, 7), employeeId: employee.id },
    );
    requireCheck(
      monthlyReport.summary.length === 1 &&
        monthlyReport.summary[0]?.employeeId === employee.id &&
        monthlyReport.summary[0]?.workDays === 1,
      'The real monthly report repository and service must count two scheduled shifts on one Jakarta work date as one work day.',
    );
    const reportedAssignments = monthlyReport.dailyDetails
      .map(({ shift }) => shift.assignmentId)
      .sort();
    requireCheck(
      monthlyReport.dailyDetails.length === 2 &&
        monthlyReport.dailyDetails.every(
          (detail) =>
            detail.employeeId === employee.id &&
            detail.date === workDateString &&
            detail.store?.id === store.id,
        ) &&
        reportedAssignments[0] === [shiftAssignmentId, secondShiftAssignmentId].sort()[0] &&
        reportedAssignments[1] === [shiftAssignmentId, secondShiftAssignmentId].sort()[1] &&
        monthlyReport.dailyDetails.some(
          (detail) =>
            detail.shift.assignmentId === secondShiftAssignmentId &&
            detail.shift.id === secondWorkShiftId &&
            detail.shift.name === 'CI Smoke Second Shift ' + fixtureId,
        ),
      'The real monthly report repository must preserve exactly both synthetic shift rows on the same work date.',
    );
  };

  try {
    const databaseIdentity = await prisma.$queryRaw<
      Array<{
        databaseName: string;
        userName: string;
      }>
    >(Prisma.sql`
      SELECT
        current_database() AS "databaseName",
        current_user AS "userName"
    `);
    const identity = databaseIdentity[0];
    requireCheck(
      databaseIdentity.length === 1 && identity?.databaseName === EXPECTED_DATABASE_NAME,
      'Connected PostgreSQL database is not the permitted ephemeral CI database.',
    );
    requireCheck(
      identity.userName === EXPECTED_DATABASE_USER,
      'Connected PostgreSQL user is not the permitted ephemeral CI user.',
    );

    await auditProbeClient.connect();
    auditProbeConnected = true;
    const probeIdentity = await auditProbeClient.query<{
      databaseName: string;
      userName: string;
    }>(`
      SELECT
        current_database() AS "databaseName",
        current_user AS "userName"
    `);
    requireCheck(
      probeIdentity.rowCount === 1 &&
        probeIdentity.rows[0]?.databaseName === EXPECTED_DATABASE_NAME &&
        probeIdentity.rows[0]?.userName === EXPECTED_DATABASE_USER,
      'Audit trigger probe connection must use the permitted ephemeral CI database and user.',
    );

    const audit = new AuditService(new PrismaAuditLogRepository(prisma));
    const consentRepository = new PrismaConsentRepository(prisma);
    const consentService = new ConsentService({
      repository: consentRepository,
      policyProvider: createConsentPolicyProvider({
        version: consentPolicyVersion,
        text: consentPolicyText,
      }),
      audit,
    });
    const deviceBindingService = new DeviceBindingService({
      repository: new PrismaDeviceBindingRepository(prisma),
      audit,
    });
    const authService = await createArgon2AuthService(
      new PrismaAuthRepository(prisma),
      audit,
      consentService,
      deviceBindingService,
    );
    const attendanceAttemptService = new AttendanceAttemptService(
      new PrismaAttendanceAttemptRepository(prisma),
      evidenceVerifier,
    );
    app = await buildApp({
      logger: false,
      readiness: createDatabaseReadinessProbe(prisma),
      auth: {
        service: authService,
        cookieSecret: randomBytes(32).toString('base64url'),
        secureCookies: false,
        allowedOrigin: ALLOWED_ORIGIN,
        sensitiveRateLimit: { max: 20, timeWindow: '15 minutes' },
      },
      attendanceAttempts: { service: attendanceAttemptService },
      consents: { service: consentService },
    });

    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    requireCheck(health.statusCode === 200, 'GET /api/v1/health must return HTTP 200.');
    requireCheck(
      hasGenericOkBody(health.json()),
      'GET /api/v1/health must return only the generic {"status":"ok"} body.',
    );

    const readiness = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    requireCheck(readiness.statusCode === 200, 'GET /api/v1/ready must return HTTP 200.');
    requireCheck(
      hasGenericOkBody(readiness.json()),
      'GET /api/v1/ready must return only the generic {"status":"ok"} body.',
    );
    requireCheck(
      readiness.headers['cache-control'] === 'no-store',
      'GET /api/v1/ready must include Cache-Control: no-store.',
    );

    const conflictingFixture = await prisma.userAccount.findFirst({
      where: { OR: [{ id: fixtureAccountId }, { username: fixtureUsername }] },
      select: { id: true },
    });
    requireCheck(conflictingFixture === null, 'Generated synthetic auth fixture must be unique.');

    const passwordHash = await argon2PasswordHasher.hash(fixturePassword);
    await prisma.userAccount.create({
      data: {
        id: fixtureAccountId,
        username: fixtureUsername,
        passwordHash,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      },
    });
    createdFixtureAccountIds.push(fixtureAccountId);

    const conflictingLockoutFixture = await prisma.userAccount.findFirst({
      where: { OR: [{ id: lockoutFixtureAccountId }, { username: lockoutFixtureUsername }] },
      select: { id: true },
    });
    requireCheck(
      conflictingLockoutFixture === null,
      'Generated synthetic lockout fixture must be unique.',
    );
    const lockoutPasswordHash = await argon2PasswordHasher.hash(lockoutFixturePassword);
    await prisma.userAccount.create({
      data: {
        id: lockoutFixtureAccountId,
        username: lockoutFixtureUsername,
        passwordHash: lockoutPasswordHash,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        mustChangePassword: false,
      },
    });
    createdFixtureAccountIds.push(lockoutFixtureAccountId);

    requireCheck(
      (await consentRepository.findLatestForAccount(fixtureAccountId)) === null,
      'Synthetic account must not have a consent record before login.',
    );

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { identifier: fixtureUsername, password: fixturePassword },
    });
    requireCheck(login.statusCode === 200, 'POST /api/v1/auth/login must return HTTP 200.');
    requireCheck(
      login.headers['cache-control'] === 'no-store',
      'POST /api/v1/auth/login must include Cache-Control: no-store.',
    );
    const sessionCookie = readSignedSessionCookie(login.headers['set-cookie'], app, requireCheck);
    assertPublicAuthResponse(login.json(), { id: fixtureAccountId, username: fixtureUsername });
    requireCheck(
      !login.body.includes(fixturePassword) && !login.body.includes(sessionCookie.token),
      'Login response must not echo the password or session token.',
    );

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: sessionCookie.cookie },
    });
    requireCheck(me.statusCode === 200, 'GET /api/v1/auth/me must authenticate the issued cookie.');
    requireCheck(
      me.headers['cache-control'] === 'no-store',
      'GET /api/v1/auth/me must include Cache-Control: no-store.',
    );
    assertPublicAuthResponse(me.json(), { id: fixtureAccountId, username: fixtureUsername });

    const signedCookieValue = app.parseCookie(sessionCookie.cookie)[SESSION_COOKIE_NAME];
    requireCheck(
      typeof signedCookieValue === 'string' && signedCookieValue.length > 0,
      'Login must provide a parseable signed session cookie value.',
    );
    const tamperedCookieValue = `${signedCookieValue[0] === 'A' ? 'B' : 'A'}${signedCookieValue.slice(1)}`;
    const tamperedMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(tamperedCookieValue)}`,
      },
    });
    requireCheck(
      tamperedMe.statusCode === 401,
      'GET /api/v1/auth/me must reject a tampered signed session cookie.',
    );

    const sessions = await prisma.session.findMany({
      where: { userAccountId: fixtureAccountId },
      select: { id: true, revokedAt: true },
    });
    requireCheck(
      sessions.length === 1 && sessions[0]?.revokedAt === null,
      'Login must persist exactly one active PostgreSQL session for the synthetic account.',
    );
    const sessionId = sessions[0]!.id;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ALLOWED_ORIGIN, cookie: sessionCookie.cookie },
    });
    requireCheck(logout.statusCode === 204, 'POST /api/v1/auth/logout must return HTTP 204.');
    requireCheck(
      logout.headers['cache-control'] === 'no-store',
      'POST /api/v1/auth/logout must include Cache-Control: no-store.',
    );

    const revokedSession = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userAccountId: true, revokedAt: true },
    });
    requireCheck(
      revokedSession?.userAccountId === fixtureAccountId &&
        revokedSession.revokedAt instanceof Date,
      'Logout must persist revocation of the PostgreSQL session row.',
    );

    const authAuditActions = await prisma.auditLog.findMany({
      where: {
        actorUserAccountId: fixtureAccountId,
        entityType: 'UserAccount',
        entityId: fixtureAccountId,
        action: { in: ['auth.login.success', 'auth.logout'] },
      },
      select: { action: true },
    });
    requireCheck(
      authAuditActions.length === 2 &&
        authAuditActions.filter(({ action }) => action === 'auth.login.success').length === 1 &&
        authAuditActions.filter(({ action }) => action === 'auth.logout').length === 1,
      'Login and logout must persist their audit events through PostgreSQL.',
    );

    const auditRowsBefore = await prisma.auditLog.findMany({
      where: {
        actorUserAccountId: fixtureAccountId,
        entityType: 'UserAccount',
        entityId: fixtureAccountId,
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        actorUserAccountId: true,
        action: true,
        entityType: true,
        entityId: true,
        beforeData: true,
        afterData: true,
        reason: true,
        clientIp: true,
        deviceIdHash: true,
        requestId: true,
        occurredAt: true,
      },
    });
    requireCheck(
      auditRowsBefore.length === 2,
      'The synthetic login/logout audit rows must exist before append-only trigger probes.',
    );

    await assertAppendOnlyTriggerCatalog(auditProbeClient);

    const syntheticAuditLogId = auditRowsBefore[0]!.id;
    const updateBlocked = await didAppendOnlyTriggerBlockMutation(
      auditProbeClient,
      'UPDATE',
      syntheticAuditLogId,
    );
    const deleteBlocked = await didAppendOnlyTriggerBlockMutation(
      auditProbeClient,
      'DELETE',
      syntheticAuditLogId,
    );
    const auditRowsAfter = await prisma.auditLog.findMany({
      where: {
        actorUserAccountId: fixtureAccountId,
        entityType: 'UserAccount',
        entityId: fixtureAccountId,
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        actorUserAccountId: true,
        action: true,
        entityType: true,
        entityId: true,
        beforeData: true,
        afterData: true,
        reason: true,
        clientIp: true,
        deviceIdHash: true,
        requestId: true,
        occurredAt: true,
      },
    });
    requireCheck(
      JSON.stringify(auditRowsAfter) === JSON.stringify(auditRowsBefore),
      'Synthetic audit fixture rows must remain unchanged after rolled-back UPDATE and DELETE probes.',
    );
    requireCheck(
      updateBlocked,
      'The append-only audit trigger must reject UPDATE with its expected SQLSTATE and message.',
    );
    requireCheck(
      deleteBlocked,
      'The append-only audit trigger must reject DELETE with its expected SQLSTATE and message.',
    );

    await assertAttendanceAttemptIdempotencyConstraint(auditProbeClient);
    await assertConcurrentAttendanceAttemptIdempotencyConstraint(databaseUrl);
    await assertAuthenticatedAttendanceAttemptHttpSmoke(consentRepository, audit);

    const lockoutStartedAt = Date.now();
    const concurrentFailures = await Promise.all(
      Array.from({ length: LOGIN_FAILURE_LIMIT }, () =>
        app!.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: ALLOWED_ORIGIN },
          payload: {
            identifier: lockoutFixtureUsername,
            password: incorrectLockoutPassword,
          },
        }),
      ),
    );
    const lockoutCompletedAt = Date.now();
    requireCheck(
      concurrentFailures.length === LOGIN_FAILURE_LIMIT,
      'The lockout probe must send exactly five concurrent bad-password requests.',
    );
    for (const response of concurrentFailures) {
      assertGenericInvalidCredentialsResponse(response, [
        lockoutFixtureUsername,
        incorrectLockoutPassword,
        lockoutFixturePassword,
      ]);
    }

    const lockedAccount = await prisma.userAccount.findUnique({
      where: { id: lockoutFixtureAccountId },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    requireCheck(
      lockedAccount?.failedLoginAttempts === LOGIN_FAILURE_LIMIT &&
        lockedAccount.lockedUntil instanceof Date &&
        lockedAccount.lockedUntil.getTime() >= lockoutStartedAt + LOGIN_LOCK_DURATION_MS &&
        lockedAccount.lockedUntil.getTime() <= lockoutCompletedAt + LOGIN_LOCK_DURATION_MS &&
        lockedAccount.lockedUntil.getTime() > lockoutCompletedAt,
      'Five concurrent failures must persist exactly five attempts and a future lock within the production 15-minute window.',
    );

    const failureAuditCount = await prisma.auditLog.count({
      where: {
        action: 'auth.login.failure',
        entityType: 'UserAccount',
        entityId: lockoutFixtureAccountId,
      },
    });
    requireCheck(
      failureAuditCount === LOGIN_FAILURE_LIMIT,
      'Each concurrent failed login must persist one generic auth.login.failure audit event.',
    );
    const sessionsAfterBadPasswords = await prisma.session.count({
      where: { userAccountId: lockoutFixtureAccountId },
    });
    requireCheck(
      sessionsAfterBadPasswords === 0,
      'Concurrent invalid logins must not create PostgreSQL sessions.',
    );

    const correctPasswordWhileLocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: {
        identifier: lockoutFixtureUsername,
        password: lockoutFixturePassword,
      },
    });
    assertGenericInvalidCredentialsResponse(correctPasswordWhileLocked, [
      lockoutFixtureUsername,
      lockoutFixturePassword,
      incorrectLockoutPassword,
    ]);

    const stillLockedAccount = await prisma.userAccount.findUnique({
      where: { id: lockoutFixtureAccountId },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    requireCheck(
      stillLockedAccount?.failedLoginAttempts === LOGIN_FAILURE_LIMIT &&
        stillLockedAccount.lockedUntil instanceof Date &&
        stillLockedAccount.lockedUntil.getTime() === lockedAccount.lockedUntil.getTime(),
      'A correct password during lockout must leave the persisted lockout state unchanged.',
    );
    const failureAuditCountAfterLockedLogin = await prisma.auditLog.count({
      where: {
        action: 'auth.login.failure',
        entityType: 'UserAccount',
        entityId: lockoutFixtureAccountId,
      },
    });
    requireCheck(
      failureAuditCountAfterLockedLogin === LOGIN_FAILURE_LIMIT + 1,
      'A correct password rejected during lockout must add one generic auth.login.failure audit event.',
    );
    const sessionsAfterLockedLogin = await prisma.session.count({
      where: { userAccountId: lockoutFixtureAccountId },
    });
    requireCheck(
      sessionsAfterLockedLogin === 0,
      'A correct password during lockout must not create a PostgreSQL session.',
    );

    // Advance only this synthetic account's lock timestamp so the expired-lock branch can be
    // exercised without waiting 15 minutes. The exact ephemeral database identity was checked
    // before fixture writes above.
    const expiredLockInstant = new Date(Date.now() - 60_000);
    const expiredLockFixture = await prisma.userAccount.update({
      where: { id: lockoutFixtureAccountId },
      data: { lockedUntil: expiredLockInstant },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    requireCheck(
      expiredLockFixture.failedLoginAttempts === LOGIN_FAILURE_LIMIT &&
        expiredLockFixture.lockedUntil instanceof Date &&
        expiredLockFixture.lockedUntil.getTime() === expiredLockInstant.getTime() &&
        expiredLockFixture.lockedUntil.getTime() < Date.now(),
      'Recovery setup must set only a past lock timestamp and preserve the failure count.',
    );

    const recoveredLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ALLOWED_ORIGIN },
      payload: {
        identifier: lockoutFixtureUsername,
        password: lockoutFixturePassword,
      },
    });
    requireCheck(
      recoveredLogin.statusCode === 200,
      'A correct password after lock expiry must return HTTP 200.',
    );
    requireCheck(
      recoveredLogin.headers['cache-control'] === 'no-store',
      'A recovered login must include Cache-Control: no-store.',
    );
    const recoveredSessionCookie = readSignedSessionCookie(
      recoveredLogin.headers['set-cookie'],
      app,
      requireCheck,
    );
    assertPublicAuthResponse(recoveredLogin.json(), {
      id: lockoutFixtureAccountId,
      username: lockoutFixtureUsername,
    });
    requireCheck(
      !recoveredLogin.body.includes(lockoutFixturePassword) &&
        !recoveredLogin.body.includes(recoveredSessionCookie.token),
      'Recovered login response must not echo the password or session token.',
    );
    const recoveredMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: recoveredSessionCookie.cookie },
    });
    requireCheck(
      recoveredMe.statusCode === 200,
      'GET /api/v1/auth/me must accept the signed cookie from the recovered login.',
    );
    requireCheck(
      recoveredMe.headers['cache-control'] === 'no-store',
      'GET /api/v1/auth/me after recovery must include Cache-Control: no-store.',
    );
    assertPublicAuthResponse(recoveredMe.json(), {
      id: lockoutFixtureAccountId,
      username: lockoutFixtureUsername,
    });
    const recoveredAccount = await prisma.userAccount.findUnique({
      where: { id: lockoutFixtureAccountId },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    requireCheck(
      recoveredAccount?.failedLoginAttempts === 0 && recoveredAccount.lockedUntil === null,
      'Successful login after lock expiry must reset the persisted lockout state.',
    );
    const recoveredActiveSessionCount = await prisma.session.count({
      where: { userAccountId: lockoutFixtureAccountId, revokedAt: null },
    });
    requireCheck(
      recoveredActiveSessionCount === 1,
      'Successful login after lock expiry must persist exactly one active PostgreSQL session.',
    );

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: sessionCookie.cookie },
    });
    requireCheck(
      afterLogout.statusCode === 401,
      'GET /api/v1/auth/me must reject the cookie after its session is revoked.',
    );
  } finally {
    try {
      try {
        if (auditProbeConnected) await auditProbeClient.end();
      } finally {
        if (createdFixtureAccountIds.length > 0) {
          // Keep the synthetic account and append-only audit rows until the disposable
          // CI database is destroyed. Deleting the account invokes ON DELETE SET NULL on
          // audit_logs, and the immutable audit trigger correctly rejects that UPDATE.
          await prisma.session.updateMany({
            where: { userAccountId: { in: createdFixtureAccountIds }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      }
    } finally {
      try {
        await app?.close();
      } finally {
        await prisma.$disconnect();
      }
    }
  }
}

async function main(): Promise<void> {
  const rootEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new SmokeCheckError(
      'DATABASE_URL is required and must target the ephemeral CI database.',
    );
  }
  assertEphemeralDatabaseUrl(databaseUrl);
  await runPostgresSmoke(databaseUrl);
}

try {
  await main();
  console.log(
    'PostgreSQL integration smoke passed: readiness, auth/session, consent gating, append-only audit trigger, employee-scoped idempotency, and authenticated attendance HTTP persistence/evidence/geofence checks succeeded.',
  );
} catch (error) {
  if (error instanceof SmokeCheckError) {
    console.error(`PostgreSQL integration smoke failed: ${error.message}`);
  } else {
    console.error(
      'PostgreSQL integration smoke failed; database and driver details were suppressed.',
    );
  }
  process.exitCode = 1;
}
