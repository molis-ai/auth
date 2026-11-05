-- Snapshot security state independently of the operation target. Never infer a
-- verified identity from request fields or create accounts during binding.
ALTER TABLE auth_product_transaction ADD COLUMN identity_version INTEGER CHECK(identity_version>=0);
ALTER TABLE auth_product_transaction ADD COLUMN verified_identity TEXT CHECK(verified_identity IS NULL OR (json_valid(verified_identity) AND json_type(verified_identity)='object'));
