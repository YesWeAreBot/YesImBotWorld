/**
 * 二期新增纯函数冒烟测试：
 * - typingTimeTU / typingSlackTU：send 的 duration 按字数线性估算打字时间（判定"模拟打字" vs "过会儿再发"）。
 *
 * 用法（typing.ts 无任何导入，可直接用 node 的类型擦除跑）：
 *   node --experimental-strip-types --experimental-transform-types scripts/smoke-phase2.ts
 */

/* eslint-disable no-console */
import { typingTimeTU, typingSlackTU } from "../src/bot/typing.ts";

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}
function eq(actual: number, expected: number, name: string) {
  check(actual === expected, `${name}（期望 ${expected}，实际 ${actual}）`);
}

function main() {
  // ---- typingTimeTU：字数线性 → 现实秒 → TU ----
  // 5 字/秒、1 TU = 1 现实秒（同步模式）：10 字 = 2 秒 = 2 TU
  eq(typingTimeTU(10, 5, 1), 2, "10 字 @5字/s 同步模式 = 2 TU");
  // 5 字 = 1 秒 = 1 TU（至少 1 TU）
  eq(typingTimeTU(5, 5, 1), 1, "5 字 = 1 TU");
  // 空消息无耗时
  eq(typingTimeTU(0, 5, 1), 0, "0 字无耗时");
  // 非同步：1 TU = 10 现实秒：50 字 @5字/s = 10 秒 = 1 TU
  eq(typingTimeTU(50, 5, 10), 1, "50 字 @5字/s 每TU10秒 = 1 TU");
  // 未满 1 TU 也至少算 1 TU（短消息也有"正在打字"的感觉）
  eq(typingTimeTU(1, 5, 10), 1, "1 字 也至少 1 TU");
  // 慢速打字：3 字/秒，30 字 = 10 秒 = 10 TU
  eq(typingTimeTU(30, 3, 1), 10, "30 字 @3字/s = 10 TU");

  // ---- typingSlackTU：打字估算 × 倍数，至少 1 × 倍数 ----
  eq(typingSlackTU(10, 5, 1, 4), 8, "10 字 估算 2 TU × 4 = 8 TU 阈值");
  eq(typingSlackTU(5, 5, 1, 4), 4, "5 字 估算 1 TU × 4 = 4 TU 阈值");
  eq(typingSlackTU(0, 5, 1, 4), 4, "空消息也至少有 1 × 4 阈值");

  // ---- 语义示例：同一条消息，duration 在阈值内 = 打字；超过 = 延期 ----
  const len = 10; // 10 字
  const slack = typingSlackTU(len, 5, 1, 4);
  const within = slack; // 刚好在阈值内
  const beyond = slack + 0.5; // 超过阈值
  check(within <= slack && beyond > slack, "阈值边界区分：<= 打字，> 延期");

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main();
