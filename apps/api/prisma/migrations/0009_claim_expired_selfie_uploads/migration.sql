ALTER TABLE "selfie_upload_intents"
ADD COLUMN "purge_claimed_at" TIMESTAMPTZ(3);

ALTER TABLE "selfie_upload_intents"
ADD CONSTRAINT "selfie_upload_intents_purge_claim_state_check"
CHECK ("status" = 'PENDING' OR "purge_claimed_at" IS NULL);
