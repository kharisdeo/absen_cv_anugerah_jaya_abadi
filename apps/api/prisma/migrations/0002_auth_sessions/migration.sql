-- Add opaque-cookie sessions without changing or rewriting existing rows.
-- Only the lowercase SHA-256 hex digest of the 256-bit cookie token is stored.
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_token_hash_sha256_hex_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "sessions_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_revoked_idx" ON "sessions"("user_account_id", "revoked_at");
CREATE INDEX "sessions_last_seen_idx" ON "sessions"("last_seen_at");
