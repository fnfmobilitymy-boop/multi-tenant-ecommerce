import fs from "node:fs";
import { checkBackups } from "./backup-status-lib.mjs";
try {
  const report = await checkBackups(process.env);
  const lines = ["Supabase 备份只读检查"];
  if (report.state === "unknown") {
    lines.push(
      `无法核实数据库备份（HTTP ${report.http}）。401/403 时请检查令牌有效期和该项目的 Backups 读取权限。`,
    );
    process.exitCode = 1;
  } else {
    lines.push(
      `API 列出的数据库备份：${report.database_backup_count} 份。`,
      `标记为完成的备份：${report.completed_backup_count} 份；未提供状态的记录：${report.unknown_status_count} 份。`,
      `最新记录时间：${report.latest_backup_at ? new Date(report.latest_backup_at).toLocaleString("zh-CN", { timeZone: "Asia/Kuala_Lumpur", hour12: false }) + "（马来西亚时间）" : "未提供"}。`,
      `PITR：${report.pitr_enabled === null ? "未知" : report.pitr_enabled ? "已启用" : "未启用"}。`,
    );
    if (report.state === "none_listed")
      lines.push("此接口没有列出备份；不能据此排除另存的外部备份。");
  }
  lines.push(
    "此结果不能证明备份可成功恢复。Storage 图片文件备份和独立恢复演练仍未核实。本检查没有下载、创建或恢复备份，也不显示令牌或备份下载地址。",
  );
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + text + "\n");
} catch {
  const text =
    "备份状态无法核实：请检查项目配置、管理令牌和网络。未执行任何备份创建或恢复操作。";
  console.error(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + text + "\n");
  process.exitCode = 1;
}
