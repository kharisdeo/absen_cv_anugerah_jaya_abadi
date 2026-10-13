-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'SUPERVISOR', 'EMPLOYEE');
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
CREATE TYPE "employee_status" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "device_binding_status" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');
CREATE TYPE "attendance_type" AS ENUM ('CHECK_IN', 'CHECK_OUT');
CREATE TYPE "attendance_validation_status" AS ENUM ('VALID', 'PENDING_VERIFICATION', 'APPROVED', 'REJECTED', 'PENDING_OFFLINE');
CREATE TYPE "attendance_record_status" AS ENUM ('ACTIVE', 'SUPERSEDED');
CREATE TYPE "daily_attendance_status" AS ENUM ('PRESENT', 'LATE', 'EARLY_LEAVE', 'MISSING_CHECKOUT', 'WAITING_VERIFICATION', 'LEAVE', 'SICK', 'ANNUAL_LEAVE', 'HOLIDAY', 'ABSENT');
CREATE TYPE "validation_method" AS ENUM ('GPS', 'QR', 'WIFI', 'SUPERVISOR', 'OFFLINE', 'ASSISTED');
CREATE TYPE "network_status" AS ENUM ('ONLINE', 'OFFLINE');
CREATE TYPE "request_type" AS ENUM ('LEAVE', 'SICK', 'ANNUAL_LEAVE', 'OVERTIME', 'CORRECTION');
CREATE TYPE "request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "recap_status" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "notification_kind" AS ENUM ('ATTENDANCE_VERIFICATION', 'ATTENDANCE_REQUEST', 'REQUEST_DECISION', 'CORRECTION_DECISION', 'SYSTEM_DISRUPTION', 'RECAP_CLOSED');

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'EMPLOYEE',
    "status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_accounts_username_not_blank_check" CHECK (length(btrim("username")) > 0),
    CONSTRAINT "user_accounts_password_hash_not_blank_check" CHECK (length(btrim("password_hash")) > 0),
    CONSTRAINT "user_accounts_failed_login_attempts_check" CHECK ("failed_login_attempts" >= 0)
);

CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "nik" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "position" TEXT,
    "status" "employee_status" NOT NULL DEFAULT 'ACTIVE',
    "employment_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employees_nik_not_blank_check" CHECK (length(btrim("nik")) > 0),
    CONSTRAINT "employees_full_name_not_blank_check" CHECK (length(btrim("full_name")) > 0),
    CONSTRAINT "employees_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "radius_meters" INTEGER NOT NULL DEFAULT 10,
    "accuracy_limit_meters" INTEGER NOT NULL DEFAULT 30,
    "wifi_public_ip" INET,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stores_name_not_blank_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "stores_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
    CONSTRAINT "stores_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
    CONSTRAINT "stores_radius_meters_check" CHECK ("radius_meters" > 0),
    CONSTRAINT "stores_accuracy_limit_meters_check" CHECK ("accuracy_limit_meters" > 0)
);

CREATE TABLE "work_shifts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_tolerance_minutes" INTEGER NOT NULL DEFAULT 0,
    "work_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "work_shifts_name_not_blank_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "work_shifts_break_minutes_check" CHECK ("break_minutes" >= 0),
    CONSTRAINT "work_shifts_late_tolerance_minutes_check" CHECK ("late_tolerance_minutes" >= 0),
    CONSTRAINT "work_shifts_work_days_check" CHECK (cardinality("work_days") BETWEEN 1 AND 7 AND "work_days" <@ ARRAY[1,2,3,4,5,6,7]::INTEGER[])
);

CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_shift_id" UUID NOT NULL,
    "store_id" UUID,
    "assigned_by_user_account_id" UUID,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shift_assignments_effective_dates_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
    CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shift_assignments_work_shift_id_fkey" FOREIGN KEY ("work_shift_id") REFERENCES "work_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shift_assignments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shift_assignments_assigned_by_user_account_id_fkey" FOREIGN KEY ("assigned_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "employee_stores" (
    "employee_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "assigned_by_user_account_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_stores_pkey" PRIMARY KEY ("employee_id", "store_id"),
    CONSTRAINT "employee_stores_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "employee_stores_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "employee_stores_assigned_by_user_account_id_fkey" FOREIGN KEY ("assigned_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "store_id" UUID,
    "holiday_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "holidays_description_not_blank_check" CHECK (length(btrim("description")) > 0),
    CONSTRAINT "holidays_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "device_bindings" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "device_id_hash" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "status" "device_binding_status" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_user_account_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_bindings_device_id_hash_not_blank_check" CHECK (length(btrim("device_id_hash")) > 0),
    CONSTRAINT "device_bindings_device_name_not_blank_check" CHECK (length(btrim("device_name")) > 0),
    CONSTRAINT "device_bindings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_bindings_approved_by_user_account_id_fkey" FOREIGN KEY ("approved_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "attendances" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "store_id" UUID,
    "shift_assignment_id" UUID,
    "work_date" DATE NOT NULL,
    "type" "attendance_type" NOT NULL,
    "server_time" TIMESTAMPTZ(3) NOT NULL,
    "device_time" TIMESTAMPTZ(3),
    "validation_status" "attendance_validation_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "record_status" "attendance_record_status" NOT NULL DEFAULT 'ACTIVE',
    "method" "validation_method" NOT NULL,
    "network_status" "network_status" NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "proof_code" TEXT,
    "device_id_hash" TEXT,
    "client_ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendances_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendances_shift_assignment_id_fkey" FOREIGN KEY ("shift_assignment_id") REFERENCES "shift_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "selfie_captures" (
    "id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "object_key" TEXT,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "watermark_applied" BOOLEAN NOT NULL DEFAULT false,
    "watermark_metadata" JSONB,
    "face_detected" BOOLEAN NOT NULL DEFAULT false,
    "liveness_passed" BOOLEAN NOT NULL DEFAULT false,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "retention_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "selfie_captures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "selfie_captures_size_bytes_check" CHECK ("size_bytes" BETWEEN 1 AND 204800),
    CONSTRAINT "selfie_captures_retention_check" CHECK ("retention_expires_at" > "captured_at"),
    CONSTRAINT "selfie_captures_deleted_object_key_check" CHECK ("deleted_at" IS NULL OR "object_key" IS NULL),
    CONSTRAINT "selfie_captures_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "location_proofs" (
    "id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy_meters" DECIMAL(8,2) NOT NULL,
    "distance_meters" DECIMAL(10,2),
    "is_mocked" BOOLEAN NOT NULL DEFAULT false,
    "source" "validation_method" NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_proofs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_proofs_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
    CONSTRAINT "location_proofs_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
    CONSTRAINT "location_proofs_accuracy_meters_check" CHECK ("accuracy_meters" > 0),
    CONSTRAINT "location_proofs_distance_meters_check" CHECK ("distance_meters" IS NULL OR "distance_meters" >= 0),
    CONSTRAINT "location_proofs_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "attendance_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "request_type" "request_type" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "attachment_object_key" TEXT,
    "requested_overtime_minutes" INTEGER,
    "status" "request_status" NOT NULL DEFAULT 'PENDING',
    "approver_user_account_id" UUID,
    "decision_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_requests_dates_check" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "attendance_requests_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "attendance_requests_overtime_minutes_check" CHECK ("requested_overtime_minutes" IS NULL OR "requested_overtime_minutes" >= 0),
    CONSTRAINT "attendance_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendance_requests_approver_user_account_id_fkey" FOREIGN KEY ("approver_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "attendance_id" UUID,
    "attendance_request_id" UUID,
    "requested_by_employee_id" UUID NOT NULL,
    "proposed_type" "attendance_type",
    "proposed_server_time" TIMESTAMPTZ(3),
    "proposed_device_time" TIMESTAMPTZ(3),
    "proposed_store_id" UUID,
    "reason" TEXT NOT NULL,
    "evidence_object_key" TEXT,
    "status" "request_status" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_user_account_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_corrections_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "attendance_corrections_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "attendance_corrections_attendance_request_id_fkey" FOREIGN KEY ("attendance_request_id") REFERENCES "attendance_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "attendance_corrections_requested_by_employee_id_fkey" FOREIGN KEY ("requested_by_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendance_corrections_proposed_store_id_fkey" FOREIGN KEY ("proposed_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendance_corrections_reviewed_by_user_account_id_fkey" FOREIGN KEY ("reviewed_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "system_disruptions" (
    "id" UUID NOT NULL,
    "store_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_disruptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_disruptions_period_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "system_disruptions_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "system_disruptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "system_disruptions_created_by_user_account_id_fkey" FOREIGN KEY ("created_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "monthly_recaps" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "store_id" UUID,
    "period_start" DATE NOT NULL,
    "status" "recap_status" NOT NULL DEFAULT 'OPEN',
    "work_days" INTEGER NOT NULL DEFAULT 0,
    "present_days" INTEGER NOT NULL DEFAULT 0,
    "late_days" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "absent_days" INTEGER NOT NULL DEFAULT 0,
    "leave_days" INTEGER NOT NULL DEFAULT 0,
    "sick_days" INTEGER NOT NULL DEFAULT 0,
    "annual_leave_days" INTEGER NOT NULL DEFAULT 0,
    "total_work_minutes" INTEGER NOT NULL DEFAULT 0,
    "approved_overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "closed_by_user_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_recaps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "monthly_recaps_period_start_check" CHECK (EXTRACT(DAY FROM "period_start") = 1),
    CONSTRAINT "monthly_recaps_counts_check" CHECK ("work_days" >= 0 AND "present_days" >= 0 AND "late_days" >= 0 AND "late_minutes" >= 0 AND "absent_days" >= 0 AND "leave_days" >= 0 AND "sick_days" >= 0 AND "annual_leave_days" >= 0 AND "total_work_minutes" >= 0 AND "approved_overtime_minutes" >= 0),
    CONSTRAINT "monthly_recaps_closing_state_check" CHECK (("status" = 'OPEN' AND "closed_by_user_account_id" IS NULL AND "closed_at" IS NULL) OR ("status" = 'CLOSED' AND "closed_by_user_account_id" IS NOT NULL AND "closed_at" IS NOT NULL)),
    CONSTRAINT "monthly_recaps_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "monthly_recaps_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "monthly_recaps_closed_by_user_account_id_fkey" FOREIGN KEY ("closed_by_user_account_id") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_account_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before_data" JSONB,
    "after_data" JSONB,
    "reason" TEXT,
    "client_ip" INET,
    "device_id_hash" TEXT,
    "request_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_action_not_blank_check" CHECK (length(btrim("action")) > 0),
    CONSTRAINT "audit_logs_entity_type_not_blank_check" CHECK (length(btrim("entity_type")) > 0),
    CONSTRAINT "audit_logs_actor_user_account_id_fkey" FOREIGN KEY ("actor_user_account_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "employee_id" UUID,
    "policy_version" TEXT NOT NULL,
    "consent_text_hash" TEXT NOT NULL,
    "purposes" JSONB NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3),
    "client_ip" INET,
    "device_id_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_records_policy_version_not_blank_check" CHECK (length(btrim("policy_version")) > 0),
    CONSTRAINT "consent_records_text_hash_not_blank_check" CHECK (length(btrim("consent_text_hash")) > 0),
    CONSTRAINT "consent_records_withdrawal_check" CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" >= "accepted_at"),
    CONSTRAINT "consent_records_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "consent_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_account_id_key" ON "employees"("account_id");
CREATE UNIQUE INDEX "employees_nik_key" ON "employees"("nik");
CREATE UNIQUE INDEX "user_accounts_username_key" ON "user_accounts"("username");
CREATE INDEX "employees_status_full_name_idx" ON "employees"("status", "full_name");
CREATE INDEX "stores_active_name_idx" ON "stores"("is_active", "name");
CREATE INDEX "work_shifts_active_name_idx" ON "work_shifts"("is_active", "name");
CREATE INDEX "shift_assignments_employee_effective_idx" ON "shift_assignments"("employee_id", "effective_from", "effective_to");
CREATE INDEX "shift_assignments_store_effective_idx" ON "shift_assignments"("store_id", "effective_from", "effective_to");
CREATE INDEX "employee_stores_store_employee_idx" ON "employee_stores"("store_id", "employee_id");
CREATE UNIQUE INDEX "holidays_store_date_key" ON "holidays"("store_id", "holiday_date");
CREATE UNIQUE INDEX "holidays_global_date_key" ON "holidays"("holiday_date") WHERE "store_id" IS NULL;
CREATE INDEX "holidays_date_idx" ON "holidays"("holiday_date");
CREATE UNIQUE INDEX "device_bindings_employee_id_device_id_hash_key" ON "device_bindings"("employee_id", "device_id_hash");
CREATE INDEX "device_bindings_employee_status_idx" ON "device_bindings"("employee_id", "status");
CREATE UNIQUE INDEX "device_bindings_one_approved_per_employee_key" ON "device_bindings"("employee_id") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "attendances_idempotency_key_key" ON "attendances"("idempotency_key");
CREATE UNIQUE INDEX "attendances_proof_code_key" ON "attendances"("proof_code");
CREATE INDEX "attendances_employee_date_validation_idx" ON "attendances"("employee_id", "work_date", "validation_status");
CREATE INDEX "attendances_store_date_validation_idx" ON "attendances"("store_id", "work_date", "validation_status");
CREATE INDEX "attendances_employee_server_time_idx" ON "attendances"("employee_id", "server_time");
CREATE UNIQUE INDEX "attendances_one_accepted_type_per_workday_key" ON "attendances"("employee_id", "work_date", "type") WHERE "record_status" = 'ACTIVE' AND "validation_status" IN ('VALID', 'APPROVED');
CREATE UNIQUE INDEX "selfie_captures_attendance_id_key" ON "selfie_captures"("attendance_id");
CREATE UNIQUE INDEX "selfie_captures_object_key_key" ON "selfie_captures"("object_key");
CREATE INDEX "selfie_captures_retention_idx" ON "selfie_captures"("retention_expires_at", "deleted_at");
CREATE UNIQUE INDEX "location_proofs_attendance_id_key" ON "location_proofs"("attendance_id");
CREATE INDEX "attendance_requests_employee_status_idx" ON "attendance_requests"("employee_id", "status", "requested_at");
CREATE INDEX "attendance_requests_status_requested_idx" ON "attendance_requests"("status", "requested_at");
CREATE UNIQUE INDEX "attendance_corrections_request_id_key" ON "attendance_corrections"("attendance_request_id");
CREATE INDEX "attendance_corrections_attendance_status_idx" ON "attendance_corrections"("attendance_id", "status");
CREATE INDEX "attendance_corrections_requester_status_idx" ON "attendance_corrections"("requested_by_employee_id", "status", "created_at");
CREATE INDEX "system_disruptions_store_active_period_idx" ON "system_disruptions"("store_id", "is_active", "starts_at", "ends_at");
CREATE UNIQUE INDEX "monthly_recaps_employee_period_store_key" ON "monthly_recaps"("employee_id", "period_start", "store_id");
CREATE UNIQUE INDEX "monthly_recaps_employee_period_global_key" ON "monthly_recaps"("employee_id", "period_start") WHERE "store_id" IS NULL;
CREATE INDEX "monthly_recaps_period_status_store_idx" ON "monthly_recaps"("period_start", "status", "store_id");
CREATE INDEX "notifications_user_read_created_idx" ON "notifications"("user_account_id", "read_at", "created_at");
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");
CREATE INDEX "audit_logs_actor_occurred_idx" ON "audit_logs"("actor_user_account_id", "occurred_at");
CREATE INDEX "audit_logs_entity_occurred_idx" ON "audit_logs"("entity_type", "entity_id", "occurred_at");
CREATE INDEX "consent_records_user_accepted_idx" ON "consent_records"("user_account_id", "accepted_at");
CREATE INDEX "consent_records_employee_accepted_idx" ON "consent_records"("employee_id", "accepted_at");

-- Keep audit rows append-only even if a future application path accidentally adds
-- an update/delete operation. A statement trigger also prevents TRUNCATE.
CREATE FUNCTION "reject_audit_log_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "audit_logs_reject_update_delete"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_mutation"();

CREATE TRIGGER "audit_logs_reject_truncate"
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_audit_log_mutation"();
