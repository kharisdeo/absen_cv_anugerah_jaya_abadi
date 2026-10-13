CREATE TYPE "attendance_attempt_processing_status" AS ENUM (
    'RECEIVED',
    'RECORDED',
    'RULE_REJECTED'
);

ALTER TABLE "attendance_attempts"
    ADD COLUMN "processing_status" "attendance_attempt_processing_status" NOT NULL DEFAULT 'RECEIVED',
    ADD COLUMN "processing_error_code" TEXT;

ALTER TABLE "attendance_attempts"
    ADD CONSTRAINT "attendance_attempts_processing_error_check"
    CHECK (("processing_status" = 'RULE_REJECTED') = ("processing_error_code" IS NOT NULL));

ALTER TABLE "attendances"
    ADD COLUMN "source_attempt_id" UUID;

CREATE UNIQUE INDEX "attendances_source_attempt_id_key"
    ON "attendances"("source_attempt_id");

ALTER TABLE "attendances"
    ADD CONSTRAINT "attendances_source_attempt_id_fkey"
    FOREIGN KEY ("source_attempt_id") REFERENCES "attendance_attempts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
