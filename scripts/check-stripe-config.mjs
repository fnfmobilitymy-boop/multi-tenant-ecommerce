import Stripe from "stripe";
import fs from "node:fs";
import { validateStripeConfiguration } from "./stripe-config-lib.mjs";
try {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new Error("Missing Stripe configuration");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    timeout: 15000,
    maxNetworkRetries: 1,
  });
  const result = await validateStripeConfiguration(stripe, process.env);
  const text = `Stripe 配置只读检查通过：${result.mode === "test" ? "测试模式" : "正式模式"}；MYR 99.90/月、外加6%税率及订阅 Webhook 已核对。此结果不代表真实扣款或自动续期已验收。`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + text + "\n");
} catch {
  console.error(
    "Stripe 配置只读检查未通过。请核对密钥权限、同一模式的月费价格/税率，以及 Webhook 地址和六项订阅事件。不会显示密钥或创建付款。",
  );
  process.exitCode = 1;
}
