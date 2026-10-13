-- Work shifts require at least one explicit ISO workday. The initial migration
-- already enforces cardinality 1..7; remove its conflicting empty-array default
-- so an omitted API value cannot reach the database as an invalid schedule.
ALTER TABLE "work_shifts"
ALTER COLUMN "work_days" DROP DEFAULT;
