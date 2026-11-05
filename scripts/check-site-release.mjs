import { verifySiteRelease } from "./site-release-lib.mjs";
let matched = false;
for (let attempt = 0; attempt < 8; attempt++) {
  try { matched = await verifySiteRelease(process.env.DEPLOYED_SITE_URL, process.env.EXPECTED_COMMIT); } catch {}
  if (matched) break;
  if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 3000));
}
if (!matched) { console.error("正式网站版本尚未匹配本次提交，请检查 Pages 发布结果或稍后重新验证。"); process.exitCode = 1; }
else console.log("网站发布版本已匹配本次提交；实际登录及业务流程仍需验收。");
