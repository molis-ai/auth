SELECT 1 FROM auth_user LIMIT 0;
SELECT user_epoch,session_revision FROM auth_login_session LIMIT 0;
SELECT payload,revision FROM auth_web_session LIMIT 0;
SELECT browser_hash,handle,payload,revision,expires_at FROM auth_browser_transaction LIMIT 0;
SELECT provider_pkce_verifier_sealed,expires_at FROM auth_product_transaction LIMIT 0;
SELECT transaction_id,delivery_status,expires_at FROM auth_verification_challenge LIMIT 0;
SELECT transaction_id,expires_at FROM auth_identity_proof LIMIT 0;
SELECT proof_hash,expires_at FROM auth_logout_receipt INDEXED BY ix_logout_receipt_proof_expiry LIMIT 0;
