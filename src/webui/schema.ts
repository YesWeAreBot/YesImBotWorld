/**
 * Koishi Schema → 可序列化结构树（WebUI 配置表单的渲染数据）。
 *
 * schemastery 的 Schema 节点通过 { uid, refs } 引用去重、属性访问时惰性解析；
 * dict 是「键 → 子 schema」的对象表。这里统一解引用后提取纯数据：
 * type / description / default / children 等，浏览器据此渲染输入控件并收集修改。
 */

export interface SchemaNode {
  /** 在当前对象里的键名（根节点无） */
  key?: string;
  type: string;
  description?: string;
  default?: unknown;
  /** 仅 "const" 节点：固定值 */
  value?: unknown;
  /** 是否在最终 schema 中必填 */
  required?: boolean;
  /** 输入控件提示（如 textarea / secret） */
  role?: string;
  children?: SchemaNode[];
  /** "array" / "dict" 的元素节点 */
  inner?: SchemaNode;
  /** 枚举选择项（union of const） */
  options?: { value: unknown; description?: string }[];
}

export interface ConfigSchemaJson {
  node: SchemaNode;
  /** 键路径 → 校验错误消息（当前配置对 schema 的符合性检查结果） */
  errors: string[];
}

/** 沿 { uid, refs } 引用链解引用（带环保护） */
function deref(node: unknown): Record<string, unknown> {
  let n = node as Record<string, unknown> | null;
  const seen = new Set<Record<string, unknown>>();
  while (n && n.refs && !seen.has(n)) {
    seen.add(n);
    n = (n.refs as Record<string, unknown>)[String(n.uid)] as Record<string, unknown> | null;
  }
  return n ?? {};
}

/** 递归序列化 schema 节点 */
export function introspect(schema: unknown, key?: string): SchemaNode {
  const s = deref(schema);
  const meta = deref(s.meta);
  const node: SchemaNode = { key, type: String(s.type ?? "unknown") };

  if (typeof meta.description === "string") node.description = meta.description;
  else if (typeof s.description === "string") node.description = s.description;
  if (s.role === "textarea") node.role = "textarea";
  else if (s.role === "secret") node.role = "secret";
  if ("default" in meta) node.default = meta.default;
  else if ("default" in s) node.default = s.default;
  if (node.type === "const") node.value = s.value;

  if (node.type === "object") {
    const dict = s.dict;
    const entries: [string, unknown, boolean][] = [];
    if (Array.isArray(dict)) {
      for (const child of dict as unknown[]) {
        const c = deref(child);
        entries.push([String(c.key), c.schema, c.required === true]);
      }
    } else if (dict && typeof dict === "object") {
      for (const [k, v] of Object.entries(dict as Record<string, unknown>)) {
        entries.push([k, v, false]);
      }
    }
    if (entries.length) {
      node.children = entries.map(([childKey, childSchema, required]) => {
        const childNode = introspect(childSchema, childKey);
        if (required) childNode.required = true;
        return childNode;
      });
    }
  } else if (node.type === "intersect" && Array.isArray(s.list)) {
    node.children = (s.list as unknown[]).map((child, i) => introspect(child, `__group_${i}`));
  } else if (node.type === "union" && Array.isArray(s.list)) {
    const items = (s.list as unknown[]).map((c) => deref(c));
    const allConst = items.every((c) => c.type === "const");
    node.options = items.map((c) => {
      const desc = deref(c.meta).description;
      return {
        value: allConst ? c.value : c.type,
        description: typeof desc === "string" ? desc : undefined,
      };
    });
    if (allConst) node.type = "select";
  } else if (node.type === "array") {
    node.inner = introspect(s.inner);
  } else if (node.type === "dict") {
    node.inner = introspect(s.inner);
  }
  return node;
}

/**
 * 校验一个配置对象是否符合 schema。
 * 直接调用 schema 本身（调用即解析+校验，非法值抛 ValidationError），
 * 比手写结构遍历更可靠（枚举、数值范围、必填等全部覆盖）。
 */
export function validateConfig(schema: unknown, value: unknown): string[] {
  if (typeof schema !== "function") return [];
  try {
    (schema as (v: unknown) => unknown)(value);
    return [];
  } catch (err) {
    return [String((err as Error).message ?? err)];
  }
}
