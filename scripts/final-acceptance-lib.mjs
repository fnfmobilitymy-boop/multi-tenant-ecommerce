const checks = {
  orders: "订单全流程",
  stripe: "Stripe扣款与订阅",
  backup_restore: "正式备份与独立恢复",
};
// Checks the owner's reviewed evidence record, not external services. Local
// tests must never write passed statuses into the production acceptance file.
export function finalAcceptance(record) {
  const pending = [];
  for (const [key, label] of Object.entries(checks)) {
    const item = record?.checks?.[key];
    if (
      record?.schema_version !== 1 ||
      item?.status !== "passed" ||
      typeof item.verified_at !== "string" ||
      !Number.isFinite(Date.parse(item.verified_at)) ||
      typeof item.reviewed_by !== "string" ||
      !item.reviewed_by.trim() ||
      !Array.isArray(item.evidence) ||
      !item.evidence.length ||
      item.evidence.some((value) => typeof value !== "string" || !value.trim())
    )
      pending.push(label);
  }
  return { passed: pending.length === 0, pending };
}
