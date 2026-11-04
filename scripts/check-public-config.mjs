import fs from "node:fs";
import { publicConfig } from "./live-check-lib.mjs";
try {
  const { root } = publicConfig(process.env);
  if (process.argv.includes("--target")) {
    const ref = process.env.SUPABASE_PROJECT_REF || new URL(root).hostname.match(/^([a-z]{20})\.supabase\.co$/)?.[1];
    if (
      !ref ||
      !/^[a-z]{20}$/.test(ref) ||
      new URL(root).hostname !== ref + ".supabase.co"
    )
      throw new Error("目标项目编号与公开 URL 不一致，停止操作");
    if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,"SUPABASE_PROJECT_REF="+ref+"\n");
  }
  console.log("公开配置格式检查通过；未输出密钥。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
