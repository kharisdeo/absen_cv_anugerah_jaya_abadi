-- The assignment ID identifies a schedule scope (including its optional store).
-- Keep employeeId in the daily key as a consistency guard and easy employee lookups.
CREATE UNIQUE INDEX "shift_assignments_id_employee_id_key"
    ON "shift_assignments"("id", "employee_id");

CREATE TABLE "daily_attendance_statuses" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_assignment_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "status" "daily_attendance_status" NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "corrected_by_attendance_correction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_attendance_statuses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "daily_attendance_employee_assignment_date_key"
        UNIQUE ("employee_id", "shift_assignment_id", "work_date"),
    CONSTRAINT "daily_attendance_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "daily_attendance_assignment_employee_fkey"
        FOREIGN KEY ("shift_assignment_id", "employee_id")
        REFERENCES "shift_assignments"("id", "employee_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "daily_attendance_correction_id_fkey"
        FOREIGN KEY ("corrected_by_attendance_correction_id")
        REFERENCES "attendance_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "daily_attendance_employee_date_status_idx"
    ON "daily_attendance_statuses"("employee_id", "work_date", "status");
CREATE INDEX "daily_attendance_date_status_idx"
    ON "daily_attendance_statuses"("work_date", "status");
