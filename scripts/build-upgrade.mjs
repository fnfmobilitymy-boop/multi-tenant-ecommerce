import fs from "node:fs";
import { createHash } from "node:crypto";
const directory = "supabase/migrations";
const files = fs
  .readdirSync(directory)
  .filter((name) => /^2026110[45]0(00[5-9]|01[01])_/.test(name))
  .sort();
const guards = {
  "011": "to_regprocedure('public.ezshop_trial_api(text,jsonb)') is not null and to_regclass('ezshop.merchant_receiving') is not null",
  "010": "to_regprocedure('public.ezshop_subscription_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_subscription_payment_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_base_release_status()') is not null",
  "005": "to_regprocedure('public.ezshop_payment_api(text,jsonb)') is not null",
  "006":
    "to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is not null",
  "007":
    "to_regprocedure('public.ezshop_specs_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_translation_access(text,integer)') is not null",
  "008":
    "to_regprocedure('public.ezshop_release_status()') is not null and to_regprocedure('public.ezshop_mail_api(text,jsonb)') is not null",
  "009":
    "to_regprocedure('public.ezshop_content_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_platform_billing_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_gateway_api(text,jsonb)') is not null",
};
if (files.length !== 7) throw new Error("Expected migrations 005–011");
let output = `-- 由 npm run build:upgrade 生成。已有 001–004 的项目使用；先审查并备份。\n-- 已存在的 RPC 链不会重命名或覆盖，整个升级在单一事务内执行。\nbegin;\nselect pg_advisory_xact_lock(73911428511630);\ndo $preflight$ begin\n if to_regprocedure('public.ezshop_finance_api(text,jsonb)') is null or not exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='orders' and column_name='fulfillment_status') then raise exception '需要先完成 001–004；本文件不会盲目初始化或替换旧表';end if;\n if to_regprocedure('public.ezshop_specs_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is null then raise exception 'RPC 链不完整，请先人工审查';end if;\nend $preflight$;\n`;
for (const file of files) {
  const version = file.split("_")[0].slice(-3);
  if (!guards[version]) throw new Error("Unknown migration");
  const sql = fs.readFileSync(directory + "/" + file, "utf8");
  const tag = "$ezshop_migration_" + version + "$";
  if (sql.includes(tag)) throw new Error("Delimiter collision");
  output += `\n-- ${file} · sha256 ${createHash("sha256").update(sql).digest("hex")}\ndo $upgrade_${version}$ begin\n if not (${guards[version]}) then\n  execute ${tag}\n${sql}\n${tag};\n end if;\nend $upgrade_${version}$;\n`;
}
output +=
  "\nnotify pgrst,'reload schema';\ncommit;\nselect public.ezshop_release_status();\n";
fs.writeFileSync("supabase/upgrade-after-004.sql", output);
console.log(
  "Generated reviewed upgrade bundle: migrations 005–011. No remote SQL executed.",
);
