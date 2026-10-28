ALTER TABLE "system_disruptions"
  ADD COLUMN "idempotency_key_hash" CHAR(64),
  ADD COLUMN "request_fingerprint" CHAR(64);

ALTER TABLE "system_disruptions"
  ADD CONSTRAINT "system_disruptions_idempotency_pair_check"
  CHECK (
    ("idempotency_key_hash" IS NULL AND "request_fingerprint" IS NULL)
    OR
    ("idempotency_key_hash" IS NOT NULL AND "request_fingerprint" IS NOT NULL)
  );

CREATE UNIQUE INDEX "system_disruptions_actor_idempotency_key"
  ON "system_disruptions" ("created_by_user_account_id", "idempotency_key_hash");
