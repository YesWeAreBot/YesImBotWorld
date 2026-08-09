/**
 * 本次修复的两个纯函数冒烟测试：
 * - shortBanGateMessage：group_ban 低于 1 分钟被拦下（robot: true 放行），整分钟放行；
 * - recallNoticeText：撤回动态的四种措辞（自己撤/撤我的/撤自己的/撤别人的）。
 *
 * 用法：
 *   esbuild scripts/smoke-fixes.ts --bundle --platform=node --format=cjs --outfile=/tmp/opencode/smoke-fixes.cjs
 *   node /tmp/opencode/smoke-fixes.cjs
 */

/* eslint-disable no-console */
import { shortBanGateMessage } from "../src/bot/agent.js";
import { recallNoticeText } from "../src/koishi/markers.js";

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

function main() {
  // ---- shortBanGateMessage ----
  check(shortBanGateMessage(0.5, false) !== null, "0.5 分钟被拦下");
  check(shortBanGateMessage(0.99, false) !== null, "不足 1 分钟被拦下");
  check(shortBanGateMessage(0.5, true) === null, "robot: true 放行秒级禁言");
  check(shortBanGateMessage(1, false) === null, "1 分钟放行");
  check(shortBanGateMessage(30, false) === null, "30 分钟放行");
  check(shortBanGateMessage(0, false) === null, "0（解除禁言）放行");
  const gate = shortBanGateMessage(0.5, false)!;
  check(gate.includes("robot: true"), "提示文本说明了绕过参数");
  check(gate.includes("0.5"), "提示文本带上了实际时长");

  // ---- recallNoticeText ----
  check(
    recallNoticeText({ operatorName: "你", selfOp: true, senderName: "你", selfSender: true, samePerson: true }) ===
      "你撤回了一条消息",
    "自己撤回自己的消息",
  );
  check(
    recallNoticeText({ operatorName: "阿强", selfOp: false, senderName: "你", selfSender: true, samePerson: false }) ===
      "阿强 撤回了一条你的消息",
    "别人撤回 Bot 发的消息",
  );
  check(
    recallNoticeText({ operatorName: "阿强", selfOp: false, senderName: "阿强", selfSender: false, samePerson: true }) ===
      "阿强 撤回了一条消息",
    "撤回自己的消息",
  );
  check(
    recallNoticeText({ operatorName: "管理员", selfOp: false, senderName: "小美", selfSender: false, samePerson: false }) ===
      "管理员 撤回了 小美 的一条消息",
    "管理员撤回别人的消息",
  );

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main();
