import type { ChatToolDef } from "../llm/chat.js";

const id = { type: "string", minLength: 1 };
const location = {
  type: ["string", "null"], minLength: 1,
  description: "直接容纳此实体的实体id，必须精确匹配快照或本批create的id，不能填未建模的地名或name。根地点、外层未知时填JSON null；不要无限补建父地点。",
};
const attribute = {
  type: "object", required: ["value", "visibility"], additionalProperties: false,
  properties: {
    value: { description: "事实的JSON值（字符串、数值、布尔、null、数组或对象），不是叙事段落。" },
    visibility: { type: "string", enum: ["public", "owner", "hidden"] },
  },
};
const attributes = { type: "object", additionalProperties: attribute };
const entityProperties = { id, name: { type: "string", minLength: 1 }, location, attributes };
const entity = {
  anyOf: [
    {
      type: "object", required: ["id", "kind", "name", "location"], additionalProperties: false,
      properties: { ...entityProperties, kind: { type: "string", enum: ["place"] } },
    },
    {
      type: "object", required: ["id", "kind", "name", "location", "controller"], additionalProperties: false,
      properties: { ...entityProperties, kind: { type: "string", enum: ["actor"] },
        controller: { type: "string", enum: ["bot", "world"], description: "初始化时id=bot的常驻角色用bot；其他新角色必须world。actor不允许owner。" } },
    },
    {
      type: "object", required: ["id", "kind", "name", "location"], additionalProperties: false,
      properties: { ...entityProperties, kind: { type: "string", enum: ["object"] },
        owner: { type: ["string", "null"], minLength: 1, description: "可选，仅物件可用。必须是已定义actor的id。无主或未知时省略或null，不能用world/public/none。" } },
    },
  ],
};
const create = {
  type: "object", required: ["op", "entity"], additionalProperties: false,
  properties: { op: { type: "string", enum: ["create"] }, entity },
};
const move = {
  type: "object", required: ["op", "id", "location"], additionalProperties: false,
  properties: { op: { type: "string", enum: ["move"] }, id, location,
    owner: { type: ["string", "null"], minLength: 1, description: "仅object可用，所属actor的id；null清除所有权。" } },
};
const update = {
  type: "object", required: ["op", "id", "changes"], additionalProperties: false,
  properties: { op: { type: "string", enum: ["update"] }, id,
    changes: { type: "object", required: ["attributes"], additionalProperties: false,
      properties: { attributes: { type: "object", description: "仅更新这些属性；值为null时删除该属性。",
        additionalProperties: { anyOf: [attribute, { type: "null" }] } } } } },
};
const say = {
  type: "object", required: ["op", "actorId", "text"], additionalProperties: false,
  properties: { op: { type: "string", enum: ["say"] }, actorId: { ...id, description: "controller=world的NPC实体id。" },
    text: { type: "string", minLength: 1 }, audience: { type: "array", items: id } },
};

/** The executable schema is shared by initialization and adjudication, not just prose. */
export function worldProposalTool(initializing: boolean): ChatToolDef {
  return { type: "function", function: {
    name: "propose_world",
    description: initializing
      ? "提交完整的结构化初始世界，全部实体在同一批create中定义。operations必须是JSON数组，不要序列化成字符串。所有引用闭合且验证通过才整体提交。"
      : "提出一笔原子世界事务。无变化可提交空operations。行动裁定必须另外给outcome。",
    parameters: { type: "object", required: ["operations"], additionalProperties: false, properties: {
      operations: { type: "array", maxItems: 200, ...(initializing ? { minItems: 2 } : {}),
        items: initializing ? create : { anyOf: [create, move, update, say] } },
      ...(initializing ? {} : { outcome: { type: "object", required: ["status"], additionalProperties: false,
        properties: { status: { type: "string", enum: ["completed", "failed"] }, reason: { type: "string", description: "失败原因或无状态变化时的简短解释" } } } }),
    } },
  } };
}

export const INITIALIZATION_RULES = `初始化/迁移必须输出完整、引用闭合的create事务，operations是数组而非字符串。先确定全部实体id，再填写引用：
- location是实体id，不是地点名称、地址或叙述。每个非null引用必须精确匹配快照或本批create中的id，允许前向引用。
- 地点树必须有根：根地点location=null。只建模最少充分的范围；宿舍已足够时让宿舍location=null，不必为了它补校园、城市、国家、地球等无限父级。已知但不建模的地址可放入属性。
- owner仅object可用，并且只能引用actor的id；actor（包括bot）和place都不能有owner。无主/未知时省略或null，不可填写world、public、none等占位字符串。
- bot必须kind=actor、controller=bot，location引用place；其他actor的controller=world。床、桌子、手机是object。聊天群、平台频道不是物理place，不要为了填location虚构“互联网”地点。
- 每个属性都必须是{value:实际JSON值,visibility:"public"|"owner"|"hidden"}，不是直接字符串。
格式示例（仅展示契约，id、名字与事实请依据本次资料选择）：
{"operations":[{"op":"create","entity":{"id":"room","kind":"place","name":"房间","location":null}},{"op":"create","entity":{"id":"bot","kind":"actor","name":"角色名","controller":"bot","location":"room","attributes":{"posture":{"value":"sitting","visibility":"public"}}}},{"op":"create","entity":{"id":"cup","kind":"object","name":"杯子","location":"room","owner":"bot"}}]}`;

