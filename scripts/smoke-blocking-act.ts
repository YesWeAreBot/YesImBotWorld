/**
 * blockingAct 专注模式冒烟测试：
 * - actBusyMessage：存在未完成的 act 时返回拦截提示（不可绕过），否则 null；
 * - Scheduler.pendingByName：能查到进行中的 act，完成后移除；
 * - availableTools：只有开启 blockingAct 时 act 的描述才提及专注模式。
 *
 * 用法：
 *   esbuild scripts/smoke-blocking-act.ts --bundle --platform=node --format=cjs --outfile=/tmp/opencode/smoke-blocking-act.cjs
 *   node /tmp/opencode/smoke-blocking-act.cjs
 */

/* eslint-disable no-console */
import { actBusyMessage } from "../src/bot/agent.js";
import { Scheduler } from "../src/bot/scheduler.js";
import { availableTools } from "../src/bot/tools.js";
import type { ToolCallRecord } from "../src/types.js";

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ---- actBusyMessage ----
  check(actBusyMessage([]) === null, "无进行中的 act => 不拦截");
  const busy = actBusyMessage([{ arguments: { description: "去厨房泡一杯咖啡" } }] as ToolCallRecord[]);
  check(busy !== null && busy.includes("泡一杯咖啡"), "拦截提示带上前一个动作的描述");
  check(busy !== null && !busy.includes("repeat"), "拦截提示没有给 repeat 绕过口");
  const busy2 = actBusyMessage([{ arguments: {} }] as ToolCallRecord[]);
  check(busy2 !== null && busy2.includes("上一件事"), "无描述时提示「上一件事」");

  // ---- Scheduler.pendingByName ----
  const logger = { info: () => {}, warn: () => {} };
  const clock = { realMsUntil: () => 0, now: () => 0 };
  const delivered: string[] = [];
  const scheduler = new Scheduler(clock as never, (content) => delivered.push(content), logger as never);

  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const actCall = {
    id: "act_1",
    name: "act",
    arguments: { description: "去厨房泡咖啡" },
    expectedAt: 0,
    issuedAt: 0,
    role: "agent",
  } as never as ToolCallRecord;
  scheduler.schedule(actCall, {
    executeAt: "now",
    run: async () => {
      await gate;
      return "（动作完成）";
    },
  });
  check(scheduler.pendingByName("act").length === 1, "进行中的 act 可被 pendingByName 查到");
  check(scheduler.pendingByName("act")[0]?.id === "act_1", "查到的是同一个调用");
  check(scheduler.pendingByName("send").length === 0, "没有进行中的 send 不会被查到");
  release();
  await sleep(20);
  check(scheduler.pendingByName("act").length === 0, "act 完成后从进行中移除");
  check(delivered.length === 1, "完成结果已交付");

  // ---- availableTools 描述门控 ----
  const on = availableTools({ tts: false, ops: {} as never, blockingAct: true });
  const off = availableTools({ tts: false, ops: {} as never, blockingAct: false });
  const actOn = on.find((t) => t.name === "act");
  const actOff = off.find((t) => t.name === "act");
  check(!!actOn?.description.includes("blockingAct"), "开启时 act 描述提及专注模式");
  check(!!actOff && !actOff.description.includes("blockingAct"), "关闭时 act 描述不提专注模式");
  check(!!actOn && actOn.signature.includes("repeat"), "act 的 repeat 参数仍保留（关闭专注模式时可用）");

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
