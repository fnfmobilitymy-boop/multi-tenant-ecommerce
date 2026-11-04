import { liveChecks, reportText } from "./live-check-lib.mjs";
import fs from "node:fs";
try {
  const report = await liveChecks(process.env);
  const text = reportText(report);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "\n```text\n" + text + "\n```\n",
    );
  if (
    !report.database_ok ||
    (!process.argv.includes("--database-only") && !report.functions_deployed)
  )
    process.exitCode = 1;
} catch {
  console.error("检查未完成：请核对公开 Supabase 配置。不会显示或上传密钥。");
  process.exitCode = 1;
}
