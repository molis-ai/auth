export interface PlatformTenant {
  tenantId: string;
  name: string;
  status: string;
  ownerUserId: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  memberCount?: number;
  ownerDisplayName?: string | null;
  ownerEmail?: string | null;
}

export interface PlatformTenantMember {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER";
  status: "ACTIVE";
  version: number;
}

export interface PlatformDirectoryUser {
  userId: string;
  displayName: string;
  email: string | null;
  status: string;
  version: number;
}

export function tenantOwner(tenant: PlatformTenant): ResolvedUserIdentity {
  return {
    primary: tenant.ownerDisplayName || tenant.ownerEmail || tenant.ownerUserId,
    secondary: tenant.ownerEmail ?? "未绑定邮箱",
    resolved: Boolean(tenant.ownerDisplayName || tenant.ownerEmail),
  };
}

export interface ResolvedUserIdentity {
  primary: string;
  secondary: string;
  resolved: boolean;
}

export function platformTenantPath(tenantId: string): string {
  return `/platform/tenants/${encodeURIComponent(tenantId)}`;
}
