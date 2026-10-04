/** Request-only projection onto native grammar subsets. Business validators remain authoritative. */
import type { ChatCompleteOptions } from "./chat.js";
import type { ChatApiType } from "./protocol.js";
import { ChatCompletionError } from "./errors.js";

type Schema = Record<string, unknown>;
type NativeApi = "responses" | "anthropic";
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Schema, key: string) => Object.hasOwn(value, key);
const primitive = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const annotations = new Set(["title", "description", "default", "examples", "$comment", "$schema", "$id"]);
// These are retained as model instructions; the original local contract still checks
// them. This common subset also works with Responses fine-tuned model grammars.
const localConstraints = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "not"]);
interface Property { node: Node; required: boolean; placeholder: boolean }
interface Node {
  wire: Schema;
  properties?: Map<string, Property>;
  items?: Node;
  alternatives?: Node[];
  allowsNull: boolean;
  hasMapping: boolean;
}
export interface NativeSchemaPreparation {
  options: ChatCompleteOptions;
  /** Append as a user task supplement; never add a system turn after the task. */
  protocolInstruction?: string;
  /** Call after protocol completion, never on log/debug/stream preview text. */
  restoreContent(content: string): string;
}
function unsupported(path: string, reason: string): never {
  throw new Error(`原生 JSON Schema 无法安全投影 ${path}: ${reason}。请简化该 schema；World 可选择 tool 响应协议。`);
}
function invalid(reason: string): never { throw new ChatCompletionError("LLM_RESPONSE_INVALID", `原生 JSON 输出的协议投影不完整：${reason}`); }
function note(schema: Schema, text: string): void { schema.description = [schema.description, text].filter(Boolean).join("\n"); }
function nullable(schema: Schema): Schema { return { anyOf: [schema, { type: "null" }], description: "可选字段的传输形式：有值时按原定义填写；不提供时填写 null，程序会恢复为省略。" }; }

/** Does not replace an application validator: only discriminate supported wire shapes. */
function matches(node: Node, value: unknown): boolean {
  const schema = node.wire;
  if (node.alternatives) return node.alternatives.some(branch => matches(branch, value));
  const permitted = Array.isArray(schema.type) ? schema.type : [schema.type];
  const validType = permitted.some(type => type === "null" ? value === null : type === "object" ? object(value)
    : type === "array" ? Array.isArray(value) : type === "integer" ? typeof value === "number" && Number.isInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type);
  if (!validType) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value)) return false;
  if (value === null) return true;
  if (node.properties && object(value)) {
    if (Object.keys(value).some(key => !node.properties!.has(key))) return false;
    for (const [key, property] of node.properties) {
      if (!own(value, key)) { if ((schema.required as string[]).includes(key)) return false; continue; }
      if (value[key] === null && property.placeholder) continue;
      if (!matches(property.node, value[key])) return false;
    }
  }
  if (node.items && Array.isArray(value) && !value.every(item => matches(node.items!, item))) return false;
  return true;
}
function restore(node: Node, value: unknown, path = "$", depth = 0): unknown {
  if (depth > 64) invalid("JSON嵌套过深");
  if (node.alternatives) {
    const candidates = node.alternatives.filter(branch => matches(branch, value));
    if (!candidates.length) invalid(`${path}不符合任何返回分支`);
    const restored = candidates.map(branch => restore(branch, value, path, depth + 1));
    if (restored.some(result => JSON.stringify(result) !== JSON.stringify(restored[0]))) invalid(`${path}多个分支的可选字段含义不一致`);
    return restored[0];
  }
  if (!matches(node, value)) invalid(`${path}字段类型、必需字段或声明范围不匹配`);
  if (value === null) return value;
  if (node.properties && object(value)) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      const property = node.properties.get(key)!;
      if (property.placeholder && item === null) continue;
      entries.push([key, restore(property.node, item, `${path}.${key}`, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  if (node.items && Array.isArray(value)) return value.map((item, index) => restore(node.items!, item, `${path}[${index}]`, depth + 1));
  return value;
}

function compile(root: Schema, api: NativeApi): Node {
  let visited = 0;
  const build = (schema: Schema, path: string, stack: readonly Schema[] = []): Node => {
    if (++visited > 2000 || stack.length > 24) unsupported(path, "schema过大、过深或递归引用");
    if (stack.includes(schema)) unsupported(path, "递归schema不在此适配范围");
    const nextStack = [...stack, schema];
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) unsupported(path, "只支持本地非递归JSON Pointer引用");
      if (Object.keys(schema).some(key => key !== "$ref" && !annotations.has(key))) unsupported(path, "$ref不能同时带结构约束");
      let resolved: unknown = root;
      for (const part of schema.$ref.slice(2).split("/")) {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!object(resolved) || !own(resolved, key)) unsupported(path, "找不到本地$ref");
        resolved = resolved[key];
      }
      if (!object(resolved)) unsupported(path, "$ref须指向schema对象");
      const result = build(resolved, path, nextStack);
      if (typeof schema.description === "string") note(result.wire, schema.description);
      return result;
    }
    const wire: Schema = {};
    if (typeof schema.title === "string") wire.title = schema.title;
    if (typeof schema.description === "string") wire.description = schema.description;
    const constraints: Schema = {};
    for (const key of Object.keys(schema)) {
      if (localConstraints.has(key)) {
        if (api === "anthropic" && key === "minItems" && [0, 1].includes(schema[key] as number)) wire[key] = schema[key];
        else constraints[key] = schema[key];
      } else if (!["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "$defs", "definitions"].includes(key) && !annotations.has(key)) unsupported(path, `不支持关键字 ${key}`);
    }
    if (Object.keys(constraints).length) note(wire, `仍须满足的原约束（由应用验证）：${JSON.stringify(constraints)}`);
    const union = schema.anyOf ?? schema.oneOf;
    if (union !== undefined) {
      if (schema.anyOf && schema.oneOf || !Array.isArray(union) || union.length < 1 || union.length > 32) unsupported(path, "union分支无效");
      if (["type", "properties", "required", "items", "enum", "const", "additionalProperties"].some(key => schema[key] !== undefined)) unsupported(path, "union须由完整独立分支定义，不能混合外层结构约束");
      const alternatives = union.map((branch, index) => { if (!object(branch)) unsupported(path, "union分支须为schema对象"); return build(branch, `${path}.anyOf[${index}]`, nextStack); });
      wire.anyOf = alternatives.map(branch => branch.wire);
      if (schema.oneOf) note(wire, "原oneOf约束仍有效：结果须且只能符合一个原始分支。");
      return { wire, alternatives, allowsNull: alternatives.some(branch => branch.allowsNull), hasMapping: alternatives.some(branch => branch.hasMapping) };
    }
    const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declaredTypes.length || declaredTypes.some(type => typeof type !== "string" || !types.has(type))) unsupported(path, "需要明确且受支持的type");
    // Object/array unions must be independent branches; nullable versions are fine.
    if (declaredTypes.filter(type => type !== "null").length > 1) unsupported(path, "多种非null类型请使用完整anyOf分支");
    wire.type = structuredClone(schema.type);
    if (schema.enum !== undefined || own(schema, "const")) {
      const choices = own(schema, "const") ? [schema.const] : schema.enum;
      if (!Array.isArray(choices) || !choices.length || choices.some(value => !primitive(value))) unsupported(path, "enum/const只支持非空标量集合");
      wire.enum = structuredClone(choices);
    }
    const allowsNull = declaredTypes.includes("null") && (!Array.isArray(wire.enum) || wire.enum.includes(null));
    const node: Node = { wire, allowsNull, hasMapping: false };
    if (declaredTypes.includes("object")) {
      if (!object(schema.properties) || schema.additionalProperties !== false) unsupported(path, "对象须声明properties并设置additionalProperties:false");
      const required = schema.required ?? [];
      if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !own(schema.properties as Schema, key))) unsupported(path, "required须只包含已声明属性");
      const fields: [string, Schema][] = [], properties = new Map<string, Property>();
      for (const [key, field] of Object.entries(schema.properties)) {
        if (!object(field)) unsupported(`${path}.${key}`, "属性须为schema对象");
        const child = build(field, `${path}.${key}`, nextStack), mandatory = required.includes(key);
        const placeholder = api === "responses" && !mandatory && !child.allowsNull;
        properties.set(key, { node: child, required: mandatory, placeholder });
        fields.push([key, placeholder ? nullable(child.wire) : child.wire]);
        node.hasMapping ||= child.hasMapping || placeholder;
      }
      node.properties = properties;
      wire.properties = Object.fromEntries(fields); wire.additionalProperties = false;
      wire.required = api === "responses" ? [...properties.keys()] : [...required];
    }
    if (declaredTypes.includes("array")) {
      if (!object(schema.items)) unsupported(path, "数组须声明单一items schema");
      node.items = build(schema.items, `${path}[]`, nextStack); wire.items = node.items.wire; node.hasMapping ||= node.items.hasMapping;
    }
    return node;
  };
  return build(root, "$");
}

function anthropicBudget(root: Node): void {
  let optional = 0, unions = 0;
  const candidates: { owner: Node; key: string; property: Property }[] = [];
  const visit = (node: Node) => {
    if (node.alternatives || Array.isArray(node.wire.type)) unions++;
    for (const [key, property] of node.properties ?? []) {
      if (!property.required) { optional++; if (!property.node.allowsNull) candidates.push({ owner: node, key, property }); }
      visit(property.node);
    }
    if (node.items) visit(node.items);
    node.alternatives?.forEach(visit);
  };
  visit(root);
  const needed = Math.max(0, optional - 24);
  if (needed > candidates.length || unions + needed > 16) unsupported("$", `Anthropic结构复杂度超出本地投影范围（${optional}个可选字段，${unions}个union）`);
  // Real World evolve repair exceeds the native optional-field limit by one.
  // Convert only the overflow; do not change every normally optional field.
  for (const { owner, key, property } of candidates.slice(0, needed)) {
    property.placeholder = true;
    (owner.wire.required as string[]).push(key);
    (owner.wire.properties as Schema)[key] = nullable(property.node.wire);
  }
  if (needed) root.hasMapping = true;
}

/** Does not change native function tool schemas: those are intentionally non-strict. */
export function prepareNativeSchema(apiType: ChatApiType, options: ChatCompleteOptions): NativeSchemaPreparation {
  const format = options.responseFormat ?? (options.responseSchema ? "json_schema" : "text");
  if (apiType === "chat-completions" || format !== "json_schema" || !options.responseSchema) return { options, restoreContent: content => content };
  const root = compile(options.responseSchema.schema, apiType);
  if (apiType === "anthropic") anthropicBudget(root);
  const wrapped = apiType === "responses" && (root.wire.type !== "object" || !!root.alternatives);
  const schema = wrapped ? { type: "object", additionalProperties: false, required: ["result"], properties: { result: root.wire } } : root.wire;
  const instruction = [
    "本次原生接口使用下列传输JSON Schema；它仅适配输出表示，不改变前述任务事实及原业务校验规则。长度、范围、互斥等原约束仍须遵守。",
    ...(wrapped ? ["最外层只输出result字段，把完整业务结果放在result内；程序收到后会去掉此外壳。"] : []),
    ...(root.hasMapping ? ["标明‘可选字段的传输形式’的字段必须出现；不提供时填null，程序仅删除这些新增的占位null。其他字段原本允许的null仍是真实值，不会被删除。"] : []),
    "以此传输格式完成本次JSON输出：", JSON.stringify(schema),
  ].join("\n");
  return { options: { ...options, responseSchema: { ...options.responseSchema, schema } }, protocolInstruction: instruction,
    restoreContent(content) {
      // No data representation changed: preserve native whitespace/text verbatim.
      if (!wrapped && !root.hasMapping) return content;
      let value: unknown;
      try { value = JSON.parse(content); } catch { invalid("返回正文不是完整JSON"); }
      if (wrapped) {
        if (!object(value) || Object.keys(value).length !== 1 || !own(value, "result")) invalid("缺少唯一result外壳字段");
        value = value.result;
      }
      return JSON.stringify(restore(root, value));
    },
  };
}
