-- RenameForeignKey
ALTER TABLE "daily_attendance_statuses" RENAME CONSTRAINT "daily_attendance_assignment_employee_fkey" TO "daily_attendance_statuses_shift_assignment_id_employee_id_fkey";

-- RenameForeignKey
ALTER TABLE "daily_attendance_statuses" RENAME CONSTRAINT "daily_attendance_correction_id_fkey" TO "daily_attendance_statuses_corrected_by_attendance_correcti_fkey";

-- RenameForeignKey
ALTER TABLE "daily_attendance_statuses" RENAME CONSTRAINT "daily_attendance_employee_id_fkey" TO "daily_attendance_statuses_employee_id_fkey";
