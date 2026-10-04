import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withoutRetiredSettings, type Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import { validateConfig } from "./schema.js";

export interface SetupHost {
  config: Config;
  configSchema: unknown;
  files: WorldFiles;
  webuiDir: string;
  isInitialized(): Promise<boolean>;
  worldRunning(): boolean;
  applyConfig(next: Config): Promise<{ message: string; port: number }>;
}

interface SetupState {
  version: 1;
  completed: boolean;
  dismissed: boolean;
  updatedAt: string | null;
  appliedAt: string | null;
  /** Only hashes are persisted here. Credentials remain in Koishi's configuration. */
  expectedConfig?: { paths: string[]; digest: string };
}

export interface SetupSnapshot {
  version: 1;
  completed: boolean;
  dismissed: boolean;
  updatedAt: string | null;
  applied: boolean;
  appliedAt: string | null;
  initialized: boolean;
  running: boolean;
  shouldPrompt: boolean;
  definitions: { botReady: boolean; worldReady: boolean };
  models: { botReady: boolean; worldReady: boolean; sameConnection: boolean };
  safety: { tokenSet: boolean; publicBinding: boolean; enabledPlatformOps: string[] };
  autoStart: boolean;
}

export class SetupRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// A setup submission can change only controls actually presented by the wizard.
// In particular, arbitrary application/device/MCP commands and server binding are excluded.
const MODEL_KEYS = ["apiType", "baseURL", "apiKey", "model", "temperature", "maxTokens", "stream", "disableThinking"];
const CONNECTION_KEYS = ["apiType", "baseURL", "apiKey", "model"] as const;
const PLATFORM_KEYS = [
  "recall", "react", "emojiLikes", "reply", "forwardMsgs", "poke", "handleRequests", "listFriends", "userInfo",
  "sendLike", "deleteFriend", "profile", "modelShow", "ocrImage", "listGroups", "groupInfo", "listMembers",
  "memberInfo", "groupHonor", "groupFiles", "groupCard", "groupName", "groupPortrait", "groupNotice",
  "getGroupNotice", "essence", "essenceList", "groupSign", "groupBan", "groupWholeBan", "groupKick", "groupAdmin",
  "specialTitle", "groupLeave",
];
const ALLOWED_PATHS = new Set([
  ...MODEL_KEYS.map(key => "bot." + key), ...MODEL_KEYS.map(key => "world." + key),
  ...PLATFORM_KEYS.map(key => "platformOps." + key),
  "autoStart", "serializeSameEndpoint", "webui.token", "bot.minIntervalMs", "bot.maxWindowChars",
  "bot.growth.enabled", "bot.growth.reviewIntervalMs", "bot.growth.minEpisodes",
  "clock.syncRealTime", "clock.epoch", "clock.tingleEveryUnits", "clock.tingleMode",
  "media.maxAttachmentsPerRequest", "media.maxAttachmentMbPerRequest",
  "apps.browserEnabled", "apps.filesEnabled", "apps.computer.mode", "apps.camera.enabled", "apps.assistant.enabled",
  "crossing.serverEnabled", "messaging.selfCommands",
]);
const SECRET_PATHS = new Set(["bot.apiKey", "world.apiKey", "webui.token"]);
const SECRET_MASK = "******";
const EMPTY_STATE: SetupState = { version: 1, completed: false, dismissed: false, updatedAt: null, appliedAt: null };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(config: unknown, field: string): unknown {
  let current = config;
  for (const key of field.split(".")) current = isObject(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  return current;
}

function setPath(config: Record<string, unknown>, field: string, value: unknown): void {
  const segments = field.split(".");
  let current = config;
  for (const key of segments.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function patchEntries(value: unknown, prefix = ""): [string, unknown][] {
  if (!isObject(value)) throw new SetupRequestError("config 及其分组必须是对象。");
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const field = prefix ? prefix + "." + key : key;
    if (ALLOWED_PATHS.has(field)) {
      if (isObject(item) || Array.isArray(item) || item === null) throw new SetupRequestError("配置字段类型无效：" + field);
      entries.push([field, item]);
    } else if ([...ALLOWED_PATHS].some(allowed => allowed.startsWith(field + "."))) {
      entries.push(...patchEntries(item, field));
    } else {
      throw new SetupRequestError("向导不能修改此配置字段：" + field);
    }
  }
  return entries;
}

function definitionReady(content: string): boolean {
  const meaningful = content.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#+[^\n]*$/gm, "").trim();
  return meaningful.length > 0 && !content.includes("尚未编写");
}

function modelReady(model: Config["bot"] | Config["world"]): boolean {
  if (typeof model.model !== "string" || !model.model.trim() || typeof model.baseURL !== "string") return false;
  try {
    const url = new URL(model.baseURL);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function publicBinding(host: string): boolean {
  return !["localhost", "::1", "[::1]"].includes(host.toLowerCase()) && !/^127(?:\.\d{1,3}){3}$/.test(host);
}

function configurationDigest(config: Config, fields: string[]): string {
  return createHash("sha256").update(JSON.stringify([...fields].sort().map(field => [field, getPath(config, field)]))).digest("hex");
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Persists setup progress without running genesis, starting a world, or contacting a model. */
export class WebUISetup {
  private readonly stateFile: string;
  private queue: Promise<unknown> = Promise.resolve();
  private reloadPending = false;

  constructor(private readonly host: SetupHost) {
    this.stateFile = path.join(host.webuiDir, "setup.json");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private parseState(raw: string | null): SetupState {
    if (raw === null) return { ...EMPTY_STATE };
    try {
      const input: unknown = JSON.parse(raw);
      if (!isObject(input) || input.version !== 1) return { ...EMPTY_STATE };
      const state: SetupState = {
        version: 1, completed: input.completed === true, dismissed: input.dismissed === true,
        updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
        appliedAt: typeof input.appliedAt === "string" ? input.appliedAt : null,
      };
      const expected = input.expectedConfig;
      if (isObject(expected) && Array.isArray(expected.paths) && expected.paths.every(field => typeof field === "string" && ALLOWED_PATHS.has(field)) &&
          typeof expected.digest === "string" && /^[a-f0-9]{64}$/.test(expected.digest)) {
        state.expectedConfig = { paths: expected.paths, digest: expected.digest };
      }
      return state;
    } catch { return { ...EMPTY_STATE }; }
  }

  private async writeState(state: SetupState): Promise<void> {
    await fs.mkdir(this.host.webuiDir, { recursive: true });
    await this.host.files.atomicWrite(this.stateFile, JSON.stringify(state, null, 2) + "\n");
  }

  private snapshot(state: SetupState, config: Config, initialized: boolean, botDef: string, worldDef: string): SetupSnapshot {
    return {
      version: 1, completed: state.completed, dismissed: state.dismissed, updatedAt: state.updatedAt,
      applied: !state.expectedConfig || !!state.appliedAt, appliedAt: state.appliedAt,
      initialized, running: this.host.worldRunning(), shouldPrompt: !initialized && !state.completed && !state.dismissed,
      definitions: { botReady: definitionReady(botDef), worldReady: definitionReady(worldDef) },
      models: { botReady: modelReady(config.bot), worldReady: modelReady(config.world),
        sameConnection: CONNECTION_KEYS.every(key => (config.bot[key] ?? (key === "apiType" ? "chat-completions" : "")) === (config.world[key] ?? (key === "apiType" ? "chat-completions" : ""))) },
      safety: { tokenSet: !!config.webui.token.trim(), publicBinding: publicBinding(config.webui.host),
        enabledPlatformOps: PLATFORM_KEYS.filter(key => getPath(config, "platformOps." + key) === true) },
      autoStart: config.autoStart,
    };
  }

  get(): Promise<SetupSnapshot> {
    return this.exclusive(async () => {
      const [raw, botDef, worldDef, initialized] = await Promise.all([
        readOptional(this.stateFile), readOptional(this.host.files.botDef), readOptional(this.host.files.worldDef), this.host.isInitialized(),
      ]);
      const state = this.parseState(raw);
      // A reload can fail after applyConfig has returned. Confirm the actual new host
      // configuration before the browser offers genesis. Later advanced edits do not
      // make an already confirmed setup incomplete again.
      if (state.expectedConfig && !state.appliedAt && configurationDigest(this.host.config, state.expectedConfig.paths) === state.expectedConfig.digest) {
        state.appliedAt = new Date().toISOString();
        await this.writeState(state);
      }
      return this.snapshot(state, this.host.config, initialized, botDef ?? "", worldDef ?? "");
    });
  }

  save(body: unknown): Promise<{ ok: true; message: string; port: number; reload: boolean; setup: SetupSnapshot }> {
    return this.exclusive(() => this.saveExclusive(body));
  }

  private async saveExclusive(body: unknown): Promise<{ ok: true; message: string; port: number; reload: boolean; setup: SetupSnapshot }> {
    if (this.reloadPending) throw new SetupRequestError("配置正在重载，请等待重连后再保存。", 409);
    if (!isObject(body) || !Object.keys(body).length || Object.keys(body).some(key => !["config", "botDef", "worldDef", "reuseBotModel", "completed", "dismissed"].includes(key))) {
      throw new SetupRequestError("向导请求必须是对象，且不能包含未知字段。");
    }
    for (const field of ["reuseBotModel", "completed", "dismissed"]) {
      if (Object.hasOwn(body, field) && typeof body[field] !== "boolean") throw new SetupRequestError(field + " 必须是布尔值。");
    }
    if (body.dismissed === true && Object.keys(body).length !== 1) throw new SetupRequestError("跳过向导只能提交 dismissed，不会保存配置或定义。");
    for (const field of ["botDef", "worldDef"]) {
      if (Object.hasOwn(body, field) && (typeof body[field] !== "string" || Buffer.byteLength(body[field]) > 1024 * 1024 || !definitionReady(body[field]))) {
        throw new SetupRequestError(field === "botDef" ? "请填写有效的角色定义（不能只有标题或尚未编写的占位）。" : "请填写有效的世界定义（不能只有标题或尚未编写的占位）。");
      }
    }
    const entries = Object.hasOwn(body, "config") ? patchEntries(body.config) : [];
    const next = withoutRetiredSettings(structuredClone(this.host.config));
    for (const [field, value] of entries) {
      const restored = SECRET_PATHS.has(field) && value === SECRET_MASK ? getPath(this.host.config, field) ?? "" : value;
      setPath(next as unknown as Record<string, unknown>, field, restored);
    }
    if (body.reuseBotModel === true) {
      for (const key of CONNECTION_KEYS) {
        // Restore the Bot's masked credential first, then copy the source connection.
        // Resolving a copied mask as world.apiKey would retain the wrong credential.
        setPath(next as unknown as Record<string, unknown>, "world." + key, next.bot[key] ?? (key === "apiType" ? "chat-completions" : ""));
      }
    }
    if (entries.length || body.reuseBotModel === true || body.completed === true) {
      const errors = validateConfig(this.host.configSchema, structuredClone(next));
      if (errors.length) throw new SetupRequestError("配置校验失败，请检查字段类型、协议及数值范围。");
    }
    if (entries.some(([field]) => field.startsWith("bot.") && MODEL_KEYS.includes(field.slice(4))) && !modelReady(next.bot)) {
      throw new SetupRequestError("Bot 需要有效的 HTTP(S) 模型服务地址和非空模型名，地址不能包含账号、密码或片段。");
    }
    if ((body.reuseBotModel === true || entries.some(([field]) => field.startsWith("world."))) && !modelReady(next.world)) {
      throw new SetupRequestError("World 需要有效的 HTTP(S) 模型服务地址和非空模型名，地址不能包含账号、密码或片段。");
    }
    const [rawState, oldBotDef, oldWorldDef, initialized] = await Promise.all([
      readOptional(this.stateFile), readOptional(this.host.files.botDef), readOptional(this.host.files.worldDef), this.host.isInitialized(),
    ]);
    const state = this.parseState(rawState);
    const botDef = typeof body.botDef === "string" ? body.botDef : oldBotDef ?? "";
    const worldDef = typeof body.worldDef === "string" ? body.worldDef : oldWorldDef ?? "";
    if (body.completed === true) {
      if (!modelReady(next.bot) || !modelReady(next.world)) throw new SetupRequestError("完成向导前，请填写 Bot 和 World 的模型服务地址与模型名。");
      if (!definitionReady(botDef) || !definitionReady(worldDef)) throw new SetupRequestError("完成向导前，请填写角色定义和世界定义。");
      if (publicBinding(next.webui.host) && !next.webui.token.trim()) throw new SetupRequestError("WebUI 对外监听时，请先设置访问令牌再完成向导。");
    }
    const touched = [...new Set([...entries.map(([field]) => field), ...(body.reuseBotModel === true ? CONNECTION_KEYS.map(key => "world." + key) : [])])];
    const changed = touched.filter(field => getPath(next, field) !== getPath(this.host.config, field));
    const reload = changed.length > 0;
    state.updatedAt = new Date().toISOString();
    if (typeof body.completed === "boolean") state.completed = body.completed;
    if (typeof body.dismissed === "boolean") state.dismissed = body.dismissed;
    if (body.completed === true) state.dismissed = false;
    if (reload) {
      state.expectedConfig = { paths: touched, digest: configurationDigest(next, touched) };
      state.appliedAt = null;
    } else if (body.completed === true && state.expectedConfig && !state.appliedAt) {
      // After a failed reload and a manual plugin restart, the administrator may
      // explicitly accept the currently active configuration. The old instance
      // remains guarded by reloadPending, so this cannot bypass an in-flight save.
      delete state.expectedConfig;
      state.appliedAt = state.updatedAt;
    }
    const snapshot = this.snapshot(state, next, initialized, botDef, worldDef);
    const backups: { file: string; content: string | null }[] = [];
    let applied = { message: body.dismissed === true ? "已跳过，可随时重新打开配置向导。" : "新手配置已保存。", port: next.webui.port };
    try {
      if (typeof body.botDef === "string" && botDef !== oldBotDef) {
        backups.push({ file: this.host.files.botDef, content: oldBotDef });
        await this.host.files.writeBotDef(botDef);
      }
      if (typeof body.worldDef === "string" && worldDef !== oldWorldDef) {
        backups.push({ file: this.host.files.worldDef, content: oldWorldDef });
        await this.host.files.writeWorldDef(worldDef);
      }
      backups.push({ file: this.stateFile, content: rawState });
      await this.writeState(state);
      // Keep this last: the real service schedules its own scope restart.
      if (reload) applied = await this.host.applyConfig(next);
    } catch (error) {
      const restored = await Promise.allSettled(backups.map(backup => backup.content === null
        ? fs.rm(backup.file, { force: true }) : this.host.files.atomicWrite(backup.file, backup.content)));
      if (restored.some(result => result.status === "rejected")) throw new SetupRequestError("配置保存失败，且部分定义或向导进度未能还原，请检查数据目录后重试。", 500);
      // Do not expose loader errors which may echo credentials or full configurations.
      throw new SetupRequestError("配置未能应用，角色定义、世界定义和向导进度已还原。请检查插件日志后重试。", 500);
    }
    this.reloadPending = reload;
    return { ok: true, ...applied, reload, setup: snapshot };
  }
}
