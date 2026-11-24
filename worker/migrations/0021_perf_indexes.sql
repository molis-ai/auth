CREATE INDEX ix_ownership_transfer_from ON auth_ownership_transfer(from_membership_id,id);
CREATE INDEX ix_ownership_transfer_to ON auth_ownership_transfer(to_membership_id,id);
CREATE INDEX ix_tenant_membership_tenant_status_id ON auth_tenant_membership(tenant_id,status,id);
CREATE INDEX ix_client_application_id ON auth_client(application_id,id);
CREATE INDEX ix_management_audit_tenant_id ON auth_management_audit(tenant_id,id);
