ALTER TABLE "attendances"
ADD COLUMN "validation_reviewed_by_user_account_id" UUID,
ADD COLUMN "validation_reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN "validation_reason" TEXT;

ALTER TABLE "attendances"
ADD CONSTRAINT "attendances_validation_reviewed_by_user_account_id_fkey"
FOREIGN KEY ("validation_reviewed_by_user_account_id")
REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "attendances_store_validation_time_idx"
ON "attendances"("store_id", "validation_status", "server_time");

CREATE INDEX "attendances_validation_time_idx"
ON "attendances"("validation_status", "server_time");

CREATE TABLE "supervisor_store_assignments" (
    "supervisor_user_account_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "assigned_by_user_account_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_store_assignments_pkey"
      PRIMARY KEY ("supervisor_user_account_id", "store_id"),
    CONSTRAINT "supervisor_store_assignments_supervisor_user_account_id_fkey"
      FOREIGN KEY ("supervisor_user_account_id") REFERENCES "user_accounts"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "supervisor_store_assignments_store_id_fkey"
      FOREIGN KEY ("store_id") REFERENCES "stores"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "supervisor_store_assignments_assigned_by_user_account_id_fkey"
      FOREIGN KEY ("assigned_by_user_account_id") REFERENCES "user_accounts"("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "supervisor_store_assignments_store_user_idx"
ON "supervisor_store_assignments"("store_id", "supervisor_user_account_id");
