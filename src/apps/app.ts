/**
 * App：Bot 手机/电脑里的应用程序抽象。
 *
 * 对 Bot 来说，MCP Server、内置天气应用等都是"手机里的 App"：
 * 平时不占据常驻工具位，用 open_app 打开后其操作（工具）才展开可用，
 * 一次只能打开一个，切换或关闭后工具随之失效。
 * （聊天平台 Koishi 也是一个 App，只是它的能力常驻工具位，打开它 = 看一眼最近消息。）
 */

/** App 提供的一个原始工具（未渲染签名） */
export interface AppRawTool {
  name: string;
  description: string;
  /** JSON Schema（MCP inputSchema），用于渲染参数签名 */
  inputSchema?: Record<string, unknown>;
}

/** 暴露给 Bot 的工具（已渲染签名、名字已消歧） */
export interface AppToolDef {
  name: string;
  signature: string;
  description: string;
}

export interface WorldApp {
  /** 唯一标识（用作 open_app 匹配与冲突前缀） */
  readonly id: string;
  /** 显示名 */
  readonly name: string;
  /** 一句话介绍（展示在应用列表里） */
  readonly description: string;
  /** 打开应用：建立连接并列出可用工具 */
  open(): Promise<{ tools: AppRawTool[] }>;
  /** 调用应用的一个工具，返回呈现给 Bot 的文本结果 */
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /** 关闭应用（断开连接/释放资源） */
  close(): Promise<void>;
}

/** 从 JSON Schema 渲染工具参数签名：`name(city: string, days?: number)` */
export function renderSignature(name: string, schema?: Record<string, unknown>): string {
  const props =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]).map(String) : []);
  const params = Object.entries(props).map(([key, raw]) => {
    const prop = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return `${key}${required.has(key) ? "" : "?"}: ${schemaType(prop)}`;
  });
  return `${name}(${params.join(", ")})`;
}

function schemaType(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) {
    return (prop.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  }
  const type = Array.isArray(prop.type) ? String(prop.type[0]) : String(prop.type ?? "");
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const items = (typeof prop.items === "object" && prop.items !== null ? prop.items : {}) as Record<string, unknown>;
      return `${schemaType(items)}[]`;
    }
    case "object":
      return "object";
    default:
      return "any";
  }
}
