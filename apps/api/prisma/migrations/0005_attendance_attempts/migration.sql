CREATE TABLE "attendance_attempts" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "device_binding_id" UUID NOT NULL,
    "type" "attendance_type" NOT NULL,
    "client_recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "network_status" "network_status" NOT NULL,
    "reported_method" "validation_method" NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy_meters" DECIMAL(8,2) NOT NULL,
    "selfie_reference_hash" CHAR(64) NOT NULL,
    "selfie_size_bytes" INTEGER NOT NULL,
    "liveness_face_detected_claim" BOOLEAN NOT NULL,
    "liveness_passed_claim" BOOLEAN NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "device_id_hash" TEXT NOT NULL,
    "client_ip" INET,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_attempts_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
    CONSTRAINT "attendance_attempts_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
    CONSTRAINT "attendance_attempts_accuracy_check" CHECK ("accuracy_meters" > 0),
    CONSTRAINT "attendance_attempts_selfie_size_check" CHECK ("selfie_size_bytes" BETWEEN 1 AND 204800),
    CONSTRAINT "attendance_attempts_reference_hash_check" CHECK ("selfie_reference_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "attendance_attempts_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "attendance_attempts_device_id_hash_check" CHECK (length(btrim("device_id_hash")) > 0),
    CONSTRAINT "attendance_attempts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendance_attempts_device_binding_id_fkey" FOREIGN KEY ("device_binding_id") REFERENCES "device_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- The unique index is the concurrency-safe idempotency authority. Application-level
-- lookup is only an optimization; all concurrent creates still meet this constraint.
CREATE UNIQUE INDEX "attendance_attempts_employee_idempotency_key"
    ON "attendance_attempts"("employee_id", "idempotency_key");
CREATE INDEX "attendance_attempts_employee_received_idx"
    ON "attendance_attempts"("employee_id", "received_at");
