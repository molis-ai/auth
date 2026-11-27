CREATE INDEX ix_user_email_verified_order
    ON auth_user_email(user_id, created_at, id)
    WHERE verified_at IS NOT NULL;

CREATE INDEX ix_managed_tenant_status_time
    ON auth_managed_tenant(status, managed_at DESC, space_id DESC);

CREATE INDEX ix_management_audit_outcome_time
    ON auth_management_audit(outcome, occurred_at DESC, id DESC);

CREATE INDEX ix_management_audit_operation_time
    ON auth_management_audit(operation, occurred_at DESC, id DESC);
