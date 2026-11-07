import fs from "node:fs";
// Presence checks only: never connect to a database, send email, or output values.
const present = (name) => typeof process.env[name] === "string" && !!process.env[name].trim();
const rows = [
  ["备份数据库连接已填写", present("SUPABASE_BACKUP_DB_URL")],
  ["独立备份密码至少24字符", present("BACKUP_ENCRYPTION_PASSPHRASE") && process.env.BACKUP_ENCRYPTION_PASSPHRASE.length >= 24],
  ["定时备份已开启", process.env.EZSHOP_BACKUP_SCHEDULE_ENABLED === "true"],
  ["邮件服务密钥已填写（可选）", present("RESEND_API_KEY")],
  ["发件地址已填写（可选）", present("MAIL_FROM")],
  ["通知任务密钥已填写（可选）", present("NOTIFICATION_JOB_SECRET")],
  ["邮件发送调度已开启（可选）", process.env.EZSHOP_EMAIL_DISPATCH_ENABLED === "true"],
];
const note = "只检查仓库安全配置是否已填写，不证明连接有效、已部署、已产生备份、可恢复或邮件已投递。当前使用人工核款，不需要支付网关。邮件未配置不影响站内订单查询；定时备份默认不开启。";
const text = "运行配置只读检查\n" + rows.map(([label, yes]) => label + "：" + (yes ? "是" : "否")).join("\n") + "\n" + note;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "\n## 运行配置只读检查\n\n| 配置 | 状态 |\n| --- | --- |\n" +
    rows.map(([label, yes]) => `| ${label} | ${yes ? "已填／已开启" : "未填／未开启"} |`).join("\n") + "\n\n" + note + "\n");
}
