CREATE TYPE "geofence_result" AS ENUM (
    'WITHIN_LIMITS',
    'OUTSIDE_RADIUS',
    'ACCURACY_EXCEEDED',
    'OUTSIDE_RADIUS_AND_ACCURACY_EXCEEDED',
    'STORE_SELECTION_REQUIRED',
    'STORE_NOT_ASSIGNED',
    'NO_ACTIVE_ASSIGNED_STORE'
);

ALTER TABLE "attendance_attempts"
    ADD COLUMN "store_id" UUID,
    ADD COLUMN "distance_meters" DECIMAL(14,6),
    ADD COLUMN "geofence_radius_meters" INTEGER,
    ADD COLUMN "accuracy_limit_meters" INTEGER,
    ADD COLUMN "geofence_result" "geofence_result" NOT NULL DEFAULT 'NO_ACTIVE_ASSIGNED_STORE',
    ADD COLUMN "repeated_coordinate" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "attendance_attempts"
    ADD CONSTRAINT "attendance_attempts_store_id_fkey"
        FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "attendance_attempts_geospatial_snapshot_check" CHECK (
        (
            "store_id" IS NULL
            AND "distance_meters" IS NULL
            AND "geofence_radius_meters" IS NULL
            AND "accuracy_limit_meters" IS NULL
            AND "geofence_result" IN ('STORE_SELECTION_REQUIRED', 'STORE_NOT_ASSIGNED', 'NO_ACTIVE_ASSIGNED_STORE')
        )
        OR
        (
            "store_id" IS NOT NULL
            AND "distance_meters" IS NOT NULL
            AND "distance_meters" >= 0
            AND "geofence_radius_meters" IS NOT NULL
            AND "geofence_radius_meters" > 0
            AND "accuracy_limit_meters" IS NOT NULL
            AND "accuracy_limit_meters" > 0
            AND "geofence_result" IN (
                'WITHIN_LIMITS',
                'OUTSIDE_RADIUS',
                'ACCURACY_EXCEEDED',
                'OUTSIDE_RADIUS_AND_ACCURACY_EXCEEDED'
            )
        )
    );

CREATE INDEX "attendance_attempts_employee_coordinate_idx"
    ON "attendance_attempts"("employee_id", "latitude", "longitude");
