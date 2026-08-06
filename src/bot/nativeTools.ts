/**
 * 原生工具声明：把插件的工具定义（签名字符串 + 描述）转换成 OpenAI tools 参数格式，
 * 让 chat 模式的 Bot-LLM 走官方 function calling 渠道（利用模型训练时的工具调用特殊 token）。
 *
 * 签名格式："name(param: type, param2?: type2)"，类型仅限：
 * string / number / boolean / string[] / 带引号的枚举联合（"a" | "b"）。
 * 每个工具额外注入 duration 参数（本协议的通用字段：动作在世界中的耗时）。
 */

import type { ChatToolDef } from "../llm/chat.js";

export interface NamedToolDef {
  name: string;
  signature: string;
  description: string;
}

/** 解析签名的参数列表；解析不了的参数按 string 兜底（绝不让工具缺席声明） */
export function signatureParams(
  signature: string,
): { name: string; required: boolean; schema: Record<string, unknown> }[] {
  const m = signature.match(/^[\w.]+\s*\(([\s\S]*)\)\s*$/);
  const inner = m?.[1]?.trim() ?? "";
  if (!inner) return [];
  const out: { name: string; required: boolean; schema: Record<string, unknown> }[] = [];
  for (const part of splitParams(inner)) {
    const pm = part.match(/^([\w]+)(\?)?\s*:\s*([\s\S]+)$/);
    if (!pm) continue;
    out.push({ name: pm[1]!, required: !pm[2], schema: typeSchema(pm[3]!.trim()) });
  }
  return out;
}

/** 按顶层逗号切分参数（枚举联合里的引号内容不受影响；本签名格式没有嵌套括号） */
function splitParams(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inStr = false;
  for (const ch of inner) {
    if (ch === '"') inStr = !inStr;
    if (ch === "," && !inStr) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function typeSchema(type: string): Record<string, unknown> {
  if (type === "number") return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (type.endsWith("[]")) return { type: "array", items: typeSchema(type.slice(0, -2).trim()) };
  // 枚举联合："self" | "world"
  if (type.includes("|")) {
    const values = [...type.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    if (values.length) return { type: "string", enum: values };
  }
  return { type: "string" };
}

/** 工具定义 → OpenAI tools 参数（附加通用的 duration 字段） */
export function toNativeToolDefs(defs: NamedToolDef[]): ChatToolDef[] {
  return defs.map((def) => {
    const params = signatureParams(def.signature);
    const properties: Record<string, unknown> = {};
    for (const p of params) properties[p.name] = p.schema;
    if (!("duration" in properties)) {
      properties.duration = {
        type: "number",
        description: "这个动作在世界中要花费的 Time Unit 数，由你自己估计；省略表示瞬间完成",
      };
    }
    return {
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: "object",
          properties,
          required: params.filter((p) => p.required).map((p) => p.name),
          // 描述里提到的确认/绕过类参数（confirm / repeat / insist…）不在签名里，放行未知键
          additionalProperties: true,
        },
      },
    };
  });
}
