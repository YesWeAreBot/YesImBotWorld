/**
 * 内置天气 App。
 *
 * - 现实世界设定（创世时由 World-LLM 判定，持久化在 meta.json）：
 *   走 Open-Meteo（免费、无需 API key）查询真实天气；
 * - 虚构世界设定：由 World-LLM 依据世界状态生成天气，并把天气沉淀进
 *   World_Status.md，保证连续查询与世界裁定的一致性。
 */

import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { AppsConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { WorldAgent } from "../world/agent.js";
import type { AppRawTool, WorldApp } from "./app.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const HTTP_TIMEOUT_MS = 15_000;

/** WMO 天气代码 → 中文描述 */
const WMO: Record<number, string> = {
  0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴",
  45: "雾", 48: "冻雾",
  51: "毛毛雨", 53: "毛毛雨", 55: "密集毛毛雨", 56: "冻毛毛雨", 57: "冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "强阵雪",
  95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

function wmoText(code: unknown): string {
  return WMO[Number(code)] ?? "未知天气";
}

export class WeatherApp implements WorldApp {
  readonly id = "weather";
  readonly name = "天气";
  readonly description = "查询当前天气与未来几天的预报";

  constructor(
    private world: WorldAgent,
    private files: WorldFiles,
    private clock: WorldClock,
    private cfg: AppsConfig,
    private logger: Logger,
  ) {}

  async open(): Promise<{ tools: AppRawTool[] }> {
    return {
      tools: [
        {
          name: "query_weather",
          description: "查询当前天气与未来几天的简要预报。city 不填时查询你当前所在的位置。",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string", description: "城市或地区名" },
            },
          },
        },
      ],
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool !== "query_weather") throw new Error(`天气应用没有 ${tool} 这个操作`);
    const city = args.city != null && String(args.city).trim() ? String(args.city).trim() : undefined;
    // 现实/虚构由创世时的判定决定；旧世界没有判定记录时按时钟同步模式推断
    const meta = await this.files.readMeta();
    const realWorld = meta.realWorld ?? this.clock.syncRealTime;
    return realWorld ? this.realWeather(city) : this.virtualWeather(city);
  }

  async close(): Promise<void> {
    /* 无连接可释放 */
  }

  // ---------- 真实天气（Open-Meteo） ----------

  private async realWeather(city?: string): Promise<string> {
    const query = city || this.cfg.weatherDefaultCity.trim();
    if (!query) {
      return "（天气应用还不知道你在哪：请在 query_weather 里给出 city 参数，比如你所在的城市。）";
    }
    let place: { latitude: number; longitude: number; label: string };
    try {
      place = await this.geocode(query);
    } catch (err) {
      return `（天气应用查不到「${query}」这个地方：${(err as Error).message ?? err}）`;
    }
    try {
      return await this.forecast(place);
    } catch (err) {
      this.logger.warn("天气查询失败: %s", err);
      return `（天气应用加载失败：${(err as Error).message ?? err}。稍后再试试。）`;
    }
  }

  private async geocode(name: string): Promise<{ latitude: number; longitude: number; label: string }> {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`地理编码服务 ${res.status}`);
    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    const hit = data.results?.[0];
    if (!hit) throw new Error("没有匹配的地名");
    const label = [hit.country, hit.admin1, hit.name]
      .map((v) => (v ? String(v) : ""))
      .filter((v, i, arr) => v && arr.indexOf(v) === i)
      .join(" ");
    return { latitude: Number(hit.latitude), longitude: Number(hit.longitude), label: label || name };
  }

  private async forecast(place: { latitude: number; longitude: number; label: string }): Promise<string> {
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "3",
    });
    const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`天气服务 ${res.status}`);
    const data = (await res.json()) as {
      current?: Record<string, unknown>;
      daily?: Record<string, unknown[]>;
    };
    const lines = [`天气 · ${place.label}`];
    const cur = data.current;
    if (cur) {
      lines.push(
        `现在：${wmoText(cur.weather_code)}，${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C），` +
          `湿度 ${cur.relative_humidity_2m}%，风速 ${cur.wind_speed_10m} km/h`,
      );
    }
    const daily = data.daily;
    if (daily?.time) {
      const dayNames = ["今天", "明天", "后天"];
      for (let i = 0; i < Math.min(3, daily.time.length); i++) {
        const rain = daily.precipitation_probability_max?.[i];
        lines.push(
          `${dayNames[i] ?? String(daily.time[i])}：${wmoText(daily.weather_code?.[i])}，` +
            `${daily.temperature_2m_min?.[i]}~${daily.temperature_2m_max?.[i]}°C` +
            (rain != null ? `，降水概率 ${rain}%` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  // ---------- 虚构天气（World-LLM 生成，读写 world_status 保持一致） ----------

  private async virtualWeather(city?: string): Promise<string> {
    const where = city ? `「${city}」` : "它当前所在的地区";
    const task =
      `Bot 打开了手机上的天气应用，查询${where}的天气（当前 ${this.clock.timeLine()}）。\n` +
      `请扮演这个天气应用给出查询结果：\n` +
      `1. check world_status（必要时也看 bot_status 确认它的位置），天气必须与世界状态中已有的天气、` +
      `季节、时段与世界设定保持一致；\n` +
      `2. 若 world_status 里没有当前天气记录或已经过时，构思合理的天气并 update world_status 把它记录下来` +
      `（这样之后的裁定与再次查询都会一致）；若查询的地点在世界设定中不存在，如实反馈查无此地；\n` +
      `3. 最后直接输出天气应用屏幕上显示的内容：当前天气与未来两三天的简要预报，` +
      `简洁、像天气 App 的界面文本，不要输出任何解释或旁白。`;
    try {
      return await this.world.query(task);
    } catch (err) {
      this.logger.warn("虚构天气生成失败: %s", err);
      return "（天气应用转了半天圈，加载失败了。稍后再试试。）";
    }
  }
}
