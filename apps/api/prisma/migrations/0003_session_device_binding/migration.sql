-- Add the optional device association for sessions. Existing sessions remain valid
-- and unbound until a new login binds them to an approved or pending device.
ALTER TABLE "sessions"
ADD COLUMN "device_binding_id" UUID;

ALTER TABLE "sessions"
ADD CONSTRAINT "sessions_device_binding_id_fkey"
FOREIGN KEY ("device_binding_id") REFERENCES "device_bindings"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sessions_device_binding_revoked_idx"
ON "sessions"("device_binding_id", "revoked_at");
