CREATE TYPE "location_failure_reason" AS ENUM (
    'PERMISSION_DENIED',
    'POSITION_UNAVAILABLE',
    'TIMEOUT'
);

ALTER TABLE "attendance_attempts"
    ALTER COLUMN "latitude" DROP NOT NULL,
    ALTER COLUMN "longitude" DROP NOT NULL,
    ALTER COLUMN "accuracy_meters" DROP NOT NULL,
    ALTER COLUMN "geofence_result" DROP NOT NULL,
    ADD COLUMN "location_failure_reason" "location_failure_reason";

ALTER TABLE "attendance_attempts"
    DROP CONSTRAINT "attendance_attempts_geospatial_snapshot_check",
    ADD CONSTRAINT "attendance_attempts_location_evidence_check" CHECK (
        (
            "latitude" IS NULL
            AND "longitude" IS NULL
            AND "accuracy_meters" IS NULL
            AND "location_failure_reason" IS NOT NULL
            AND "store_id" IS NULL
            AND "distance_meters" IS NULL
            AND "geofence_radius_meters" IS NULL
            AND "accuracy_limit_meters" IS NULL
            AND "geofence_result" IS NULL
            AND "repeated_coordinate" = FALSE
        )
        OR
        (
            "latitude" IS NOT NULL
            AND "longitude" IS NOT NULL
            AND "accuracy_meters" IS NOT NULL
            AND "location_failure_reason" IS NULL
            AND "latitude" BETWEEN -90 AND 90
            AND "longitude" BETWEEN -180 AND 180
            AND "accuracy_meters" > 0
            AND (
                (
                    "store_id" IS NULL
                    AND "distance_meters" IS NULL
                    AND "geofence_radius_meters" IS NULL
                    AND "accuracy_limit_meters" IS NULL
                    AND "geofence_result" IN (
                        'STORE_SELECTION_REQUIRED',
                        'STORE_NOT_ASSIGNED',
                        'NO_ACTIVE_ASSIGNED_STORE'
                    )
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
            )
        )
    );
