CREATE INDEX ix_logout_receipt_proof_expiry
ON auth_logout_receipt(proof_hash, expires_at);
