import { it, expect } from "vitest";
import { finalAcceptance } from "../scripts/final-acceptance-lib.mjs";
it("真实验收记录未完成时阻止正式发布，不把已有测试通过当作验收", () => {
  expect(
    finalAcceptance({
      schema_version: 1,
      checks: {
        orders: { status: "pending" },
        stripe: { status: "pending" },
        backup_restore: { status: "pending" },
      },
    }),
  ).toEqual({
    passed: false,
    pending: ["订单全流程", "Stripe扣款与订阅", "正式备份与独立恢复"],
  });
});
it("缺少证据、日期或复核人都不能通过；只有全部复核记录完整才放行", () => {
  const record = {
    schema_version: 1,
    checks: Object.fromEntries(
      ["orders", "stripe", "backup_restore"].map((key) => [
        key,
        {
          status: "passed",
          verified_at: "2026-11-05T00:00:00Z",
          reviewed_by: "fixture-reviewer",
          evidence: ["fixture evidence; not a production record"],
        },
      ]),
    ),
  };
  expect(finalAcceptance(record).passed).toBe(true);
  for (const change of [
    { evidence: [] },
    { reviewed_by: "" },
    { verified_at: null },
    { status: "pending" },
  ])
    expect(
      finalAcceptance({
        ...record,
        checks: {
          ...record.checks,
          stripe: { ...record.checks.stripe, ...change },
        },
      }).passed,
    ).toBe(false);
  expect(finalAcceptance(null).passed).toBe(false);
});
