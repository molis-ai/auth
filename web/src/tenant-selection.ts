export async function syncCreatedTenant<T extends { tenantId: string; status: string }>(
  createdId: string,
  tenants: readonly T[],
  selection: { value: T | undefined },
  clearMembers: () => void,
  loadMembers: (tenant: T) => Promise<void>,
): Promise<void> {
  if (selection.value?.tenantId !== createdId) return;
  const current = tenants.find(tenant => tenant.tenantId === createdId);
  selection.value = current;
  if (current?.status === "ACTIVE") await loadMembers(current);
  else clearMembers();
}
