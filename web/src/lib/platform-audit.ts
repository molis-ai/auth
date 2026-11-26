export interface PlatformTenant {
  tenantId: string;
  name: string;
  status: string;
  ownerUserId: string;
  version: number;
}

export interface PlatformDirectoryUser {
  userId: string;
  displayName: string;
  email: string | null;
  status: string;
  version: number;
}

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface AuditEvent {
  auditEventId: string;
  actorUserId: string;
  operation: string;
  target: {
    kind: string;
    id: string;
  };
  tenantId: string | null;
  occurredAt: string;
  result: string;
  changes: AuditChange[] | null;
}

export type AuditCategory = "all" | "account" | "tenant" | "app" | "billing";
export type ResolvedAuditCategory = Exclude<AuditCategory, "all">;

export interface AuditOperationMeta {
  label: string;
  category: ResolvedAuditCategory;
}

export interface ResolvedUserIdentity {
  primary: string;
  secondary: string;
  resolved: boolean;
}

const OPERATION_META: Record<string, AuditOperationMeta> = {
  "tenant.create": { label: "平台创建团队", category: "tenant" },
  "tenant.self-create": { label: "自助创建团队", category: "tenant" },
  "tenant.update": { label: "更新团队信息", category: "tenant" },
  "tenant.disable": { label: "停用团队", category: "tenant" },
  "tenant.enable": { label: "恢复启用团队", category: "tenant" },
  "member.role": { label: "变更成员角色", category: "tenant" },
  "member.remove": { label: "移除团队成员", category: "tenant" },
  "member.leave": { label: "成员退出团队", category: "tenant" },
  "invitation.create": { label: "发送成员邀请", category: "tenant" },
  "invitation.accept": { label: "接受团队邀请", category: "tenant" },
  "invitation.decline": { label: "拒绝团队邀请", category: "tenant" },
  "invitation.revoke": { label: "撤销团队邀请", category: "tenant" },
  "transfer.initiate": { label: "发起所有权移交", category: "tenant" },
  "transfer.accept": { label: "确认所有权移交", category: "tenant" },
  "transfer.cancel": { label: "取消所有权移交", category: "tenant" },
  "user.status": { label: "变更用户状态", category: "account" },
  "user.email": { label: "修改用户邮箱", category: "account" },
  "permission.set": { label: "更新平台权限", category: "account" },
  "application.create": { label: "创建应用", category: "app" },
  "application.update": { label: "更新应用配置", category: "app" },
  "client.create": { label: "签发客户端", category: "app" },
  "client.update": { label: "更新客户端配置", category: "app" },
  "client.secret-rotate": { label: "轮换客户端密钥", category: "app" },
  "client.revoke": { label: "吊销客户端", category: "app" },
  "catalog.feature-create": { label: "新增目录功能项", category: "billing" },
  "catalog.plan-create": { label: "新增订阅套餐", category: "billing" },
  "subscription.create": { label: "创建订阅", category: "billing" },
  "subscription.update": { label: "调整订阅与席位", category: "billing" },
  "subscription.renew": { label: "续期订阅", category: "billing" },
  "seat.assign": { label: "分配团队席位", category: "billing" },
  "seat.release": { label: "释放团队席位", category: "billing" },
  "seat.reassign": { label: "改派团队席位", category: "billing" },
};

export function auditOperationMeta(operation: string): AuditOperationMeta {
  const exact = OPERATION_META[operation];
  if (exact) return exact;
  if (/^(tenant|member|invitation|transfer)\./.test(operation)) {
    return { label: operation, category: "tenant" };
  }
  if (/^(application|client)\./.test(operation)) {
    return { label: operation, category: "app" };
  }
  if (/^(catalog|subscription|seat)\./.test(operation)) {
    return { label: operation, category: "billing" };
  }
  return { label: operation, category: "account" };
}

export function resolveDirectoryUser(
  userId: string | null | undefined,
  usersById: ReadonlyMap<string, PlatformDirectoryUser>,
  hasUserRead: boolean,
): ResolvedUserIdentity {
  if (!userId) return { primary: "—", secondary: "", resolved: false };
  const found = usersById.get(userId);
  if (found) {
    return {
      primary: found.displayName || userId,
      secondary: found.email ?? "未绑定邮箱",
      resolved: true,
    };
  }
  return {
    primary: userId,
    secondary: hasUserRead ? "未在当前目录找到该账号" : "需 USER_READ 权限展开姓名",
    resolved: false,
  };
}

export function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelativeAuditTime(iso: string, nowMs = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const diffMs = nowMs - time;
  if (diffMs < 0) return formatAuditTimestamp(iso).slice(0, 10);
  if (diffMs < 60_000) return "刚刚";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} 天前`;
  return formatAuditTimestamp(iso).slice(0, 10);
}

export function formatDiffValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function targetKindTone(kind: string): "tenant" | "app" | "user" | "billing" | "neutral" {
  const normalized = String(kind ?? "").toUpperCase();
  if (normalized === "TENANT" || normalized === "MEMBERSHIP" || normalized === "INVITATION" || normalized === "TRANSFER") {
    return "tenant";
  }
  if (normalized === "APPLICATION" || normalized === "CLIENT") return "app";
  if (normalized === "USER" || normalized === "PERMISSION") return "user";
  if (normalized === "SUBSCRIPTION" || normalized === "SEAT" || normalized === "CATALOG") return "billing";
  return "neutral";
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  return false;
}
