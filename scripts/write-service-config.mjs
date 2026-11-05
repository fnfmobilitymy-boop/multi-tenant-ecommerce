import fs from "node:fs";
import path from "node:path";
const root = process.env.RUNNER_TEMP;
if (!root) throw new Error("Only run in the deployment workflow");
const names = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PRO_TAX_RATE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "MAIL_FROM",
  "NOTIFICATION_JOB_SECRET",
];
const site =
  process.env.APP_URL ||
  "https://" +
    process.env.GITHUB_REPOSITORY_OWNER +
    ".github.io/" +
    process.env.GITHUB_REPOSITORY.split("/")[1] +
    "/";
const url = new URL(site);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error("Invalid APP_URL");
url.pathname = url.pathname.replace(/\/+$/, "") + "/";
const entries = [
  ["APP_URL", url.toString()],
  ...names
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
];
fs.writeFileSync(
  path.join(root, "ezshop-services.env"),
  entries
    .map(([name, value]) => name + "=" + JSON.stringify(value))
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log("已准备服务配置；未提供的可选服务密钥保持原设置。不会输出密钥。");
