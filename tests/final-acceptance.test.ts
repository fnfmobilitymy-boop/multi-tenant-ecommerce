import { it, expect } from "vitest";
import { finalAcceptance } from "../scripts/final-acceptance-lib.mjs";
it("用户明确改为测试后上线时可发布，但不伪造正式验收结果", () => {
  const record = { schema_version: 1, checks: { stripe: { status: "pending" } }, release_policy: {
    mode: "tested_release", authorized_by: "user", instruction: "测试好了就正式上线", authorized_on: "2026-11-05",
    evidence: ["isolated test evidence"], limitations: ["real payment remains unverified"],
  }};
  expect(finalAcceptance(record)).toEqual({ passed: true, pending: [], basis: "tested_release" });
  expect(record.checks.stripe.status).toBe("pending");
  for (const patch of [{ authorized_by: "" }, { evidence: [] }, { limitations: [] }, { authorized_on: "" }]) {
    expect(finalAcceptance({ ...record, release_policy: { ...record.release_policy, ...patch } }).passed).toBe(false);
  }
});
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


it("人工收款不要求停用网关的交易证明，但订单和备份不能随之跳过",()=>{
 const passed={status:"passed",verified_at:"2026-11-07T00:00:00Z",reviewed_by:"fixture-reviewer",evidence:["fixture only; not production evidence"]};
 const policy={goods_confirmation:"merchant_manual",pro_approval:"platform_manual",gateway_required:false,authorized_by:"user",authorized_on:"2026-11-07",instruction:"暂不接网关，均人工查账"};
 const record={schema_version:1,payment_policy:policy,checks:{orders:passed,stripe:{status:"not_applicable"},backup_restore:passed}};
 expect(finalAcceptance(record)).toEqual({passed:true,pending:[]});
 for(const key of ["orders","backup_restore"]){expect(finalAcceptance({...record,checks:{...record.checks,[key]:{status:"pending"}}}).passed).toBe(false);}
 for(const patch of [{goods_confirmation:"automatic"},{gateway_required:true},{authorized_by:""},{instruction:""},{authorized_on:""}]){
  expect(finalAcceptance({...record,payment_policy:{...policy,...patch}}).pending).toContain("Stripe扣款与订阅");
 }
});
