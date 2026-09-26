import type { Config } from "../config.js";
import type { DeviceSession } from "./device.js";

export interface DeviceAppCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: "chat" | "app";
  active: boolean;
  status: "ready" | "disabled" | "unconfigured" | "stopped";
  reason: string;
  configurable?: boolean;
}

/** Administrator UI only. An advertised application does not grant the actor a tool. */
export function deviceAppCatalog(config: Pick<Config, "apps" | "world">, installed: DeviceSession["apps"], running: boolean): DeviceAppCatalogEntry[] {
  const { apps, world } = config;
  const live = new Map(installed.map(app => [app.id, app]));
  const catalog: DeviceAppCatalogEntry[] = [];
  const add = (id: string, name: string, description: string, enabled: boolean, setup = "", configurable = false) => {
    const actual = live.get(id);
    const status = !enabled ? "disabled" : setup ? "unconfigured" : running && actual ? "ready" : "stopped";
    catalog.push({ id, name, description, kind: id === "chat" ? "chat" : "app", active: status === "ready" && !!actual?.active,
      status, reason: status === "disabled" ? "尚未启用，可在应用设置中开启。" : status === "unconfigured" ? setup
        : status === "stopped" ? running ? "应用尚未加载，应用配置并重新启动世界后可用。" : "世界尚未运行；启动后可以操作，现在仍可修改应用设置。" : "已就绪", configurable });
  };
  add("chat", apps.chatAppName, "读取会话、发现群与好友、发送消息", true);
  add("settings", "设置", "各应用通知权限与限时免打扰", true);
  add("weather", "天气", "查询所在世界的天气", apps.weatherEnabled);
  add("browser", "浏览器", "浏览网页、搜索、点击与截图；架空世界使用本世界互联网", apps.browserEnabled, "", true);
  add("notes", "记事本", "草稿、剪贴板、作业本、账本与待办", apps.notesEnabled);
  add("news", "新闻", "阅读这个世界的新闻与最近大事", apps.newsEnabled);
  add("clock", "时钟", "世界时钟、闹钟、倒计时与秒表", apps.clockEnabled, "", true);
  const camera = apps.camera;
  add("camera", "相机", "根据眼前的可见场景拍照，照片保存到相册", !!camera?.enabled,
    !camera?.baseURL?.trim() || !camera?.model?.trim() ? "需要在设置中填写图像服务地址与模型名称。" : "", true);
  const assistant = apps.assistant;
  const model = assistant?.mode === "independent" ? assistant : world;
  add("assistant", assistant?.name?.trim() || "小助手", "独立问答、实时生成，可自定义名称与模型", !!assistant?.enabled,
    !model?.baseURL?.trim() || !model?.model?.trim() ? assistant?.mode === "independent" ? "需要设置助手自己的模型地址与名称。" : "当前借用 World 模型，请先在配置页设置 World 模型。" : "", true);
  for (const app of installed) {
    if (catalog.some(entry => entry.id === app.id)) continue;
    catalog.push({ ...app, active: running && app.active, status: running ? "ready" : "stopped", reason: running ? "已就绪" : "启动世界后可使用。" });
  }
  return catalog;
}
