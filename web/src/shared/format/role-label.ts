const labels: Readonly<Record<string, string>> = {
  OWNER: "所有者",
  ADMIN: "管理员",
  MEMBER: "成员",
};

export function roleLabel(role: string) {
  return labels[role] ?? role;
}
