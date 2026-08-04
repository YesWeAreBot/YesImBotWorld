/**
 * 电脑设备（与手机平级的另一台设备）冒烟测试：
 * 验证 ComputerDevice 按世界性质与实现方式（mode）展开正确的工具，
 * 以及 open_computer / close_computer 的开关语义。不依赖真实 Docker / VNC。
 *
 * 用法：
 *   esbuild scripts/smoke-computer.ts --bundle --platform=node --format=cjs --outfile=/tmp/opencode/smoke-computer.cjs
 *   node /tmp/opencode/smoke-computer.cjs
 */

/* eslint-disable no-console */
import { ComputerDevice } from "../src/apps/computerDevice.js";

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

function fakeApp(id: string, name: string, tools: { name: string; description: string }[]) {
  return {
    id,
    name,
    description: "",
    open: async () => ({ tools, opening: `你打开了${name}。` }),
    call: async (tool: string) => `called:${name}:${tool}`,
    close: async () => {},
  };
}

const logger = { info: () => {}, warn: () => {} };

function makeDevice(opts: {
  realWorld: boolean;
  mode: string;
  readyOk?: boolean;
  remote?: boolean;
  reserved?: string[];
}) {
  const files = { readMeta: async () => ({ realWorld: opts.realWorld }) };
  const clock = { syncRealTime: false };
  const terminal = fakeApp("terminal", "终端", [{ name: "run_command", description: "执行命令" }]);
  const fm = fakeApp("files", "资源管理器", [
    { name: "list", description: "列文件" },
    { name: "show", description: "看文件" },
  ]);
  const remote = opts.remote
    ? fakeApp("remote_desktop", "远程桌面", [
        { name: "screen", description: "截屏" },
        { name: "mouse", description: "鼠标" },
        { name: "keyboard", description: "键盘" },
      ])
    : null;
  const computer = { ensureReady: async () => ({ ok: opts.readyOk ?? true, error: "电脑没开机" }) };
  const cfg = { mode: opts.mode };
  return new ComputerDevice(
    terminal as never,
    fm as never,
    remote as never,
    computer as never,
    files as never,
    clock as never,
    cfg as never,
    new Set(opts.reserved ?? []),
    logger as never,
  );
}

async function main() {
  // ---- 虚构世界：无论 mode 都是模拟电脑（终端 + 资源管理器） ----
  {
    const d = makeDevice({ realWorld: false, mode: "off" });
    const r = await d.open();
    check(!("error" in r), "虚构世界 + mode=off 也能打开电脑（由 World-LLM 扮演）");
    if (!("error" in r)) {
      check(r.defs.map((x) => x.name).join(",") === "run_command,list,show", "虚拟电脑工具 = run_command + list + show");
      check(r.opening.includes("打开了自己的电脑"), "开场提到打开电脑");
    }
    check(d.isOpen, "open_computer 后处于开机状态");
    const called = await d.call("run_command", { command: "ls" });
    check(called === "called:终端:run_command", "call 路由到终端 run_command");
    await d.close();
    check(!d.isOpen, "close_computer 后关机，工具失效");
    check(d.activeToolNames().length === 0, "关机后 activeToolNames 为空");
  }

  // ---- 现实世界 + off：没有电脑 ----
  {
    const d = makeDevice({ realWorld: true, mode: "off" });
    const r = await d.open();
    check("error" in r, "现实世界 + mode=off => 打不开（返回错误）");
    if ("error" in r) check(r.error.includes("off"), "错误信息提到 mode off");
  }

  // ---- 现实世界 + docker：终端 + 资源管理器；Docker 不可用时报错 ----
  {
    const d = makeDevice({ realWorld: true, mode: "docker" });
    const r = await d.open();
    check(!("error" in r), "现实世界 + mode=docker 正常开机");
    if (!("error" in r)) {
      check(r.defs.map((x) => x.name).join(",") === "run_command,list,show", "docker 电脑工具 = run_command + list + show");
    }
    const d2 = makeDevice({ realWorld: true, mode: "docker", readyOk: false });
    const r2 = await d2.open();
    check("error" in r2, "现实世界 + docker 未就绪 => 打不开（返回错误）");
  }

  // ---- 现实世界 + remote_desktop：屏幕/鼠标/键盘 ----
  {
    const d = makeDevice({ realWorld: true, mode: "remote_desktop", remote: true });
    const r = await d.open();
    check(!("error" in r), "现实世界 + mode=remote_desktop 正常开机");
    if (!("error" in r)) {
      check(r.defs.map((x) => x.name).join(",") === "screen,mouse,keyboard", "远程桌面电脑工具 = screen + mouse + keyboard");
      check(r.opening.includes("远程桌面"), "开场提到远程桌面");
    }
    const d2 = makeDevice({ realWorld: true, mode: "remote_desktop", remote: false });
    const r2 = await d2.open();
    check("error" in r2, "remote_desktop 但未提供远程桌面实现 => 返回错误");
  }

  // ---- 与常驻工具同名时加前缀消歧 ----
  {
    const d = makeDevice({ realWorld: true, mode: "docker", reserved: ["list"] });
    const r = await d.open();
    if (!("error" in r)) {
      check(r.defs.some((x) => x.name === "files.list"), "与常驻工具同名的 list 加前缀 files.list");
    }
  }

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
