import { AuthError } from "../../sdk/browser/src/index.ts";

const messages: Record<string, string> = {
  INVALID_REQUEST: "请检查填写的信息后重试。",
  INVALID_CREDENTIALS: "登录或验证信息不正确，请检查后重试。",
  LOGIN_REQUIRED: "请先登录。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  SESSION_REVOKED: "登录已失效，请重新登录。",
  FORBIDDEN: "你没有执行此操作的权限。",
  VERSION_CONFLICT: "信息已发生变化，请刷新后重新确认。",
  IDEMPOTENCY_CONFLICT: "这次操作的状态已变化，请刷新后核对结果。",
  IDENTITY_IN_USE: "该登录方式已被其他账号使用，请换用另一种方式。",
  LAST_LOGIN_METHOD: "请先添加另一种可用登录方式，再解绑当前方式。",
  RATE_LIMITED: "操作太频繁，请稍后再试。",
  TRANSACTION_EXPIRED: "本次验证已结束，请重新发起。",
  OWNER_TRANSFER_REQUIRED: "请先完成所有权交接，再退出租户。",
  CAPACITY_CONFLICT: "席位容量不足，请先核对现有分配。",
  POLICY_MISMATCH: "当前账号入口的配置不匹配，请联系管理员。",
  NOT_FOUND: "这项信息已不存在或无法访问，请刷新后查看。",
  AUTH_UNAVAILABLE: "账号服务暂时不可用，请稍后再试。",
  RESULT_UNKNOWN: "暂时无法确认操作结果，请刷新核对后再决定是否重试。",
  CANCELLED: "操作已取消。",
};

export function accountErrorMessage(error: unknown): string {
  if (error instanceof AuthError)
    return messages[error.code] ?? "操作未完成，请刷新核对当前状态。";
  return error instanceof Error ? error.message : "操作未完成，请稍后再试。";
}
