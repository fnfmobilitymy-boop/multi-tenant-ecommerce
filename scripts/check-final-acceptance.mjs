import fs from "node:fs";
import { finalAcceptance } from "./final-acceptance-lib.mjs";
let result;
try {
  result = finalAcceptance(
    JSON.parse(fs.readFileSync("docs/final-acceptance.json", "utf8")),
  );
} catch {
  result = { passed: false, pending: ["验收记录缺失或无法读取"] };
}
const text = result.passed
  ? result.basis === "tested_release"
    ? "用户已授权测试通过后上线；继续执行构建、后端配置与发布检查。实际订单及正式备份恢复仍需核实；停用的支付网关不列为当前必做项。"
    : "正式验收记录已齐全，继续执行本次最终发布检查。"
  : "暂不发布：尚未完成正式验收——" +
    result.pending.join("、") +
    "。模拟测试、配置可达或手动输入DEPLOY不会将这些项目自动标记为完成。";
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + text + "\n");
if (!result.passed) process.exitCode = 1;
