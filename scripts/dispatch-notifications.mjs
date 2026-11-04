const root = new URL(process.env.VITE_SUPABASE_URL);
if (root.protocol !== "https:" || root.username || root.password)
  throw new Error("Invalid Supabase URL");
root.pathname = "/functions/v1/send-notifications";
root.search = "";
root.hash = "";
const secret = process.env.NOTIFICATION_JOB_SECRET;
if (!secret) throw new Error("未配置 NOTIFICATION_JOB_SECRET，未发送");
const response = await fetch(root, {
  method: "POST",
  headers: {
    Authorization: "Bearer " + secret,
    "Content-Type": "application/json",
  },
  body: "{}",
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error("通知任务未完成，HTTP " + response.status);
const result = await response.json();
if(!Number.isSafeInteger(result.accepted)||!Number.isSafeInteger(result.failed)||result.accepted<0||result.failed<0)throw new Error("通知任务响应格式无效，未认定发送成功");
console.log(
  JSON.stringify({
    accepted: Number(result.accepted) || 0,
    failed: Number(result.failed) || 0,
    note: "服务商接受不代表客户已经收到",
  }),
);
if (result.failed) process.exitCode = 1;
