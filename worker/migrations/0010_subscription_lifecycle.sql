-- User commercial entitlement revisions are independent of identity/session versions.
CREATE TABLE billing_user_revision (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_user(id),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);

-- Freeze each published version's seat label as well as its feature set.
ALTER TABLE billing_plan_seat_type ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE billing_plan_seat_type SET name=(SELECT name FROM billing_seat_type WHERE id=seat_type_id);
