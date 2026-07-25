import type { Context } from "koishi";
import type { Config } from "./config.js";
import { WorldService } from "./service.js";

export const name = "yesimbot-world";
export const inject = ["database"];
export { Config } from "./config.js";
export * from "./types.js";

export const usage = `
YesImBot World：让 Bot 生活在由 World-LLM 维护的虚拟世界中。

使用步骤：
1. 配置 Bot-LLM 与 World-LLM 的 API；
2. 编辑数据目录下的 Bot_Definition.md 与 World_Definition.md（首次启用插件后自动生成模板）；
3. 执行指令 world.init 创世；
4. 执行指令 world.start，世界开始运转，Bot-LLM 进入持续推理。

Bot 会自主生活：在世界中行动（act）、等待（wait）、休息（rest）、
翻看手机消息（check_msg / select_channel）并通过 Koishi 发消息（send）。
打开频道或发消息后，Bot 会持续关注该频道一段时间（期间消息必定呈现内容），
直到超时或它主动放下手机（put_down_phone）。
`;

export function apply(ctx: Context, config: Config) {
  ctx.plugin(WorldService, config);
}
