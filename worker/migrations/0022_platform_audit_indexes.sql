CREATE INDEX ix_management_audit_time ON auth_management_audit(occurred_at DESC,id DESC);
CREATE INDEX ix_managed_tenant_time ON auth_managed_tenant(managed_at DESC,space_id DESC);
-- ix_management_audit_tenant already covers tenant-scoped descending reads
-- via a reverse scan over (tenant_id, occurred_at, id).
