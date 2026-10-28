ALTER TABLE "selfie_upload_intents"
    ADD COLUMN "watermarked_object_key" TEXT,
    ADD COLUMN "watermarked_size_bytes" INTEGER,
    ADD COLUMN "watermark_applied" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT "selfie_upload_intents_watermarked_size_check"
      CHECK (
        "watermarked_size_bytes" IS NULL
        OR "watermarked_size_bytes" BETWEEN 1 AND 204800
      ),
    ADD CONSTRAINT "selfie_upload_intents_watermark_applied_check"
      CHECK (
        NOT "watermark_applied"
        OR ("watermarked_object_key" IS NOT NULL AND "watermarked_size_bytes" IS NOT NULL)
      );

CREATE UNIQUE INDEX "selfie_upload_intents_watermarked_object_key_key"
    ON "selfie_upload_intents"("watermarked_object_key");

CREATE INDEX "selfie_upload_intents_watermark_queue_idx"
    ON "selfie_upload_intents"("status", "watermark_applied", "created_at");
