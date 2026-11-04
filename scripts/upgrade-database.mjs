import fs from "node:fs";
const env = process.env;
const ref = env.SUPABASE_PROJECT_REF || new URL(env.VITE_SUPABASE_URL).hostname.match(/^([a-z]{20})\.supabase\.co$/)?.[1];
if (env.UPGRADE_CONFIRM !== "UPGRADE_AND_DEPLOY")
  throw new Error("需要在工作流明确确认已备份并审查升级文件");
if (!ref || !/^[a-z]{20}$/.test(ref) || !env.SUPABASE_ACCESS_TOKEN)
  throw new Error("缺少有效项目编号或 Supabase 管理令牌");
const publicHost = new URL(env.VITE_SUPABASE_URL).hostname;
if (publicHost !== ref + ".supabase.co")
  throw new Error("公开 URL 与待升级项目不一致，停止执行");
const endpoint =
  "https://api.supabase.com/v1/projects/" + ref + "/database/query";
async function query(sql) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error("Supabase 管理接口拒绝请求，HTTP " + response.status);
  return response.json();
}
const inspected = await query(
  "select to_regprocedure('public.ezshop_finance_api(text,jsonb)') is not null and exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='orders' and column_name='fulfillment_status') as base_ready",
);
if (!Array.isArray(inspected) || inspected[0]?.base_ready !== true)
  throw new Error("现有项目不符合 001–004 升级前提，请先人工审查结构");
await query(fs.readFileSync("supabase/upgrade-after-004.sql", "utf8"));
console.log("受控升级事务已执行；不输出业务数据。请继续只读检查及实际验收。");
