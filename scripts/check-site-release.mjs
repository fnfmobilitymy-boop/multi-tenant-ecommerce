import { verifySiteRelease, verifySiteAssets } from "./site-release-lib.mjs";
let matched = false;
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    matched = await verifySiteRelease(
      process.env.DEPLOYED_SITE_URL,
      process.env.EXPECTED_COMMIT,
    );
    if (matched)
      matched = await verifySiteAssets(process.env.DEPLOYED_SITE_URL);
  } catch {
    matched = false;
  }
  if (matched) break;
  if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 3000));
}
if (!matched) {
  console.error(
    "网站版本或脚本样式加载尚未通过，请检查 Pages 域名、EZSHOP_CUSTOM_DOMAIN 变量、HTTPS 及发布结果。",
  );
  process.exitCode = 1;
} else
  console.log(
    "网站发布版本、资源路径与脚本样式加载均通过；实际登录及业务流程仍需验收。",
  );
