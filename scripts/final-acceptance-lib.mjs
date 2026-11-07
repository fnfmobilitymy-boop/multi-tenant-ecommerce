const checks = {
  orders: "订单全流程",
  stripe: "Stripe扣款与订阅",
  backup_restore: "正式备份与独立恢复",
};
// Checks the owner's reviewed evidence record, not external services. Local
// tests must never write passed statuses into the production acceptance file.
export function finalAcceptance(record) {
  const policy = record?.release_policy;
  if (record?.schema_version === 1 && policy?.mode === "tested_release" &&
      policy.authorized_by === "user" && typeof policy.instruction === "string" &&
      policy.instruction.trim() && Number.isFinite(Date.parse(policy.authorized_on)) &&
      Array.isArray(policy.evidence) && policy.evidence.length > 0 &&
      policy.evidence.every((v) => typeof v === "string" && v.trim()) &&
      Array.isArray(policy.limitations) && policy.limitations.length > 0 &&
      policy.limitations.every((v) => typeof v === "string" && v.trim())) {
    return { passed: true, pending: [], basis: "tested_release" };
  }
  const manual = record?.payment_policy;
  const manualPayments = manual?.goods_confirmation === "merchant_manual" &&
    manual?.pro_approval === "platform_manual" && manual?.gateway_required === false &&
    manual?.authorized_by === "user" && typeof manual?.instruction === "string" &&
    !!manual.instruction.trim() && typeof manual?.authorized_on === "string" &&
    Number.isFinite(Date.parse(manual.authorized_on));
  const pending = [];
  for (const [key, label] of Object.entries(checks)) {
    const item = record?.checks?.[key];
    // An explicitly disabled payment provider is outside the manual workflow.
    // This does not certify any real order, payment, or restore result.
    if (key === "stripe" && manualPayments && item?.status === "not_applicable") continue;
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
