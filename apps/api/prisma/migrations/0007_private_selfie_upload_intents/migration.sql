CREATE TYPE "selfie_upload_intent_status" AS ENUM ('PENDING', 'ATTACHED');

CREATE TABLE "selfie_upload_intents" (
    "reference_hash" CHAR(64) NOT NULL,
    "employee_id" UUID NOT NULL,
    "device_binding_id" UUID NOT NULL,
    "object_key" TEXT,
    "staging_object_key" TEXT,
    "sealed_object_key" TEXT,
    "content_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "status" "selfie_upload_intent_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "retention_expires_at" TIMESTAMPTZ(3),
    "attached_attempt_id" UUID,
    "watermark_metadata" JSONB,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "selfie_upload_intents_pkey" PRIMARY KEY ("reference_hash"),
    CONSTRAINT "selfie_upload_intents_reference_hash_check" CHECK ("reference_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "selfie_upload_intents_object_key_check" CHECK ("object_key" IS NULL OR length("object_key") > 0),
    CONSTRAINT "selfie_upload_intents_staging_object_key_check" CHECK ("staging_object_key" IS NULL OR length("staging_object_key") > 0),
    CONSTRAINT "selfie_upload_intents_sealed_object_key_check" CHECK ("sealed_object_key" IS NULL OR length("sealed_object_key") > 0),
    CONSTRAINT "selfie_upload_intents_content_type_check" CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "selfie_upload_intents_size_check" CHECK ("declared_size_bytes" BETWEEN 1 AND 204800),
    CONSTRAINT "selfie_upload_intents_state_check" CHECK (
      ("status" = 'PENDING' AND "object_key" IS NOT NULL AND "staging_object_key" = "object_key" AND "sealed_object_key" IS NOT NULL AND "attached_attempt_id" IS NULL AND "retention_expires_at" IS NULL AND "deleted_at" IS NULL)
      OR
      ("status" = 'ATTACHED' AND "sealed_object_key" IS NULL AND "attached_attempt_id" IS NOT NULL AND "retention_expires_at" IS NOT NULL AND (("object_key" IS NOT NULL AND "deleted_at" IS NULL) OR ("object_key" IS NULL AND "deleted_at" IS NOT NULL)))
    ),
    CONSTRAINT "selfie_upload_intents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "selfie_upload_intents_device_binding_id_fkey" FOREIGN KEY ("device_binding_id") REFERENCES "device_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "selfie_upload_intents_attached_attempt_id_fkey" FOREIGN KEY ("attached_attempt_id") REFERENCES "attendance_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "selfie_upload_intents_object_key_key" ON "selfie_upload_intents"("object_key");
CREATE UNIQUE INDEX "selfie_upload_intents_sealed_object_key_key" ON "selfie_upload_intents"("sealed_object_key");
CREATE UNIQUE INDEX "selfie_upload_intents_attached_attempt_id_key" ON "selfie_upload_intents"("attached_attempt_id");
CREATE INDEX "selfie_upload_intents_employee_status_expiry_idx" ON "selfie_upload_intents"("employee_id", "status", "expires_at");
CREATE INDEX "selfie_upload_intents_binding_status_expiry_idx" ON "selfie_upload_intents"("device_binding_id", "status", "expires_at");
CREATE INDEX "selfie_upload_intents_retention_idx" ON "selfie_upload_intents"("retention_expires_at");
CREATE INDEX "selfie_upload_intents_status_retention_idx" ON "selfie_upload_intents"("status", "retention_expires_at");
CREATE INDEX "selfie_upload_intents_status_created_idx" ON "selfie_upload_intents"("status", "created_at");
