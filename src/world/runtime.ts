import { createHash, randomUUID } from "node:crypto";
import type { WorldFiles } from "../files.js";
import type { WorldClock } from "../clock.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../llm/chat.js";
import type { ToolCallRecord } from "../types.js";
import { Prompts } from "../prompts.js";
import { debug } from "../webui/debug.js";
import { WorldKernel } from "./kernel.js";
import { INITIALIZATION_RULES, worldProposalTool } from "./proposal.js";
import { KernelError, type WorldOperation, type WorldSnapshot, type TransactionProposal, type WorldObservation } from "./state.js";


type Infer = (messages: ChatMessage[], tools: ChatToolDef[], signal?: AbortSignal) => Promise<ChatResult>;
type Outcome = { status: "completed" | "failed"; reason?: string };
type Finish = { id: string; speech?: string };

/** The model proposes; controller authorization and durable lifecycle remain outside it. */
export class StructuredWorld {
  private opening?: Promise<WorldKernel>;
  private tail: Promise<unknown> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private active = new Map<string, { fingerprint: string; promise: Promise<boolean> }>();
  private lifetime = new AbortController();
  private epoch = 0;
  constructor(private files: WorldFiles, private clock: WorldClock, private infer: Infer, private prompts = new Prompts()) {}
  async kernel(): Promise<WorldKernel> {
    if (!this.opening) this.opening = WorldKernel.open(this.files.base, { now: () => this.clock.now() }).then(async k => {
      this.files.bindKernel(k);
      await this.recoverInterrupted(k);
      return k;
    }).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private async recoverInterrupted(k: WorldKernel): Promise<void> {
    const pending = Object.values(k.snapshot().actions).filter(action => action.status === "pending");
    if (pending.length) await k.commit({ idempotencyKey: `recovery:${randomUUID()}`, source: "recovery", operations: pending.map(action => ({ op: "action.finish", id: action.id, status: "failed", reason: "执行进程中断，未提交动作结果。" })) });
  }
  resume(): void { if (this.lifetime.signal.aborted) this.lifetime = new AbortController(); }
  stop(): void { this.epoch++; this.lifetime.abort(); for (const c of this.controllers.values()) c.abort(); }
  async shutdown(): Promise<void> { this.stop(); await Promise.allSettled([...this.active.values()].map(item => item.promise)); await this.tail; }
  cancel(actorId: string): void { for (const [key, c] of this.controllers) if (key.startsWith(`${actorId}:`)) c.abort(); }
  async reload(): Promise<void> {
    await this.shutdown();
    if (this.opening) { const k = await this.opening; await k.reload(); await this.recoverInterrupted(k); }
    this.resume();
  }
  private serial<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = () => { signal?.throwIfAborted(); return fn(); };
    const promise = this.tail.then(run, run);
    this.tail = promise.catch(() => {});
    return abortable(promise, signal);
  }
  async ensure(botDef?: string, worldDef?: string): Promise<void> {
    const k = await this.kernel();
    if (k.snapshot().entities.bot) return;
    const signal = this.lifetime.signal;
    await this.serial(async () => {
      if (k.snapshot().entities.bot) return;
      signal.throwIfAborted();
      const oldBot = await this.files.readText(this.files.botStatus);
      const oldWorld = await this.files.readText(this.files.worldStatus);
      if (oldBot.trim() || oldWorld.trim()) await this.files.snapshot("before-structured-migration");
      const defs = { bot: botDef ?? await this.files.readText(this.files.botDef), world: worldDef ?? await this.files.readText(this.files.worldDef) };
      const task = `初始化结构化世界。只使用create操作，必须创建id=bot、kind=actor、controller=bot的常驻角色及其所在place。其他actor的controller必须world。所有引用必须有效。将旧资料迁移为最少充分的事实；矛盾或时间不明的旧日记不能当作现在事实，不要生成未来剧情。\n${JSON.stringify({ definitions: defs, legacy: { bot: oldBot, world: oldWorld } })}`;
      await this.change(task, "initialize", undefined, undefined, signal, true);
    }, signal);
  }
  async observe(actorId = "bot", args: { target?: string; modality?: string } = {}): Promise<WorldObservation> {
    await this.ensure();
    if (args.modality && !["sight", "all", "self"].includes(args.modality)) throw new Error("Unsupported observation modality");
    return (await this.kernel()).observe(actorId, {
      ...(args.target ? { target: args.target } : {}),
      ...(args.modality === "self" ? { selfOnly: true, consume: false } : {}),
      ...(args.modality === "sight" ? { includeSpeech: false, consume: false } : {}),
    });
  }
  async query(actorId: string, task: string): Promise<string> {
    await this.ensure();
    return JSON.stringify({ query: task, observation: await (await this.kernel()).peek(actorId) });
  }
  act(actorId: string, call: ToolCallRecord, deliver: (text: string) => void, signal?: AbortSignal, beforeCommit?: () => boolean): Promise<boolean> {
    const epoch = this.epoch;
    const id = `${actorId}:${call.id}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ actorId, arguments: call.arguments, expectedAt: call.expectedAt })).digest("hex");
    let entry = this.active.get(id);
    if (entry && entry.fingerprint !== fingerprint) return Promise.reject(new Error("同一动作ID不能重用于不同请求"));
    if (!entry) {
      const promise = this.runAct(actorId, id, fingerprint, call, signal, beforeCommit);
      entry = { fingerprint, promise }; this.active.set(id, entry);
      const owner = entry;
      void promise.finally(() => { if (this.active.get(id) === owner) this.active.delete(id); }).catch(() => {});
    }
    return abortable(entry.promise, signal).then(async completed => {
      if (epoch !== this.epoch) return completed;
      const k = await this.kernel(); const action = k.snapshot().actions[id];
      const observation = await k.observe(actorId);
      if (epoch === this.epoch) deliver(JSON.stringify({ observation, action: { id, status: action?.status, ...(action?.status === "failed" ? { reason: "动作未完成，请依据当前观测重新判断条件。" } : action?.status === "cancelled" ? { reason: "动作已取消。" } : {}) } }));
      return completed;
    });
  }
  private async runAct(actorId: string, id: string, fingerprint: string, call: ToolCallRecord, signal?: AbortSignal, beforeCommit?: () => boolean): Promise<boolean> {
    const c = new AbortController(); this.controllers.set(id, c);
    const abort = () => c.abort(); signal?.addEventListener("abort", abort, { once: true });
    const lifetime = this.lifetime.signal; lifetime.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || lifetime.aborted) c.abort();
    let k: WorldKernel | undefined;
    try {
      c.signal.throwIfAborted();
      await abortable(this.ensure(), c.signal); k = await this.kernel();
      const existing = k.snapshot().actions[id];
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new Error("动作ID已被不同请求使用");
        if (existing.status === "pending") throw new Error("已有未恢复的同名动作");
        return existing.status === "completed";
      }
      const intent = String(call.arguments.description ?? call.arguments.str ?? "").trim();
      if (!intent) throw new Error("动作意图不能为空");
      if (!Number.isFinite(call.expectedAt) || call.expectedAt < 0) throw new Error("动作完成时间必须非负且有限");
      if (call.arguments.speech !== undefined && (typeof call.arguments.speech !== "string" || !call.arguments.speech.trim())) throw new Error("speech必须是角色本人提供的非空原文");
      const speech = typeof call.arguments.speech === "string" ? call.arguments.speech : undefined;
      const target = typeof call.arguments.target === "string" && call.arguments.target ? call.arguments.target : undefined;
      const targetIds = target ? [k.resolveObserved(actorId, target)] : [];
      const observationId = typeof call.arguments.observationId === "string" ? call.arguments.observationId
        : target ? k.observationIdFor(actorId, target) : (k.latestObservation(actorId) ?? await k.observe(actorId, { consume: false })).observationId;
      const snapshot = k.snapshot();
      const expectedVersions = Object.fromEntries([actorId, ...targetIds].map(key => [key, snapshot.entities[key]?.revision ?? null]));
      await k.commit({ idempotencyKey: `${id}:start`, actorId, expectedVersions, correlationId: id, source: "action", operations: [{ op: "action.start", action: {
        id, actorId, intent, targetIds, expectedEnd: Math.max(call.expectedAt, this.clock.now()), basedOnObservationId: observationId, requestFingerprint: fingerprint,
      } }] }, { signal: c.signal });
      await this.until(call.expectedAt, c.signal);
      const outcome = await this.serial(() => this.change(`裁定行动者${actorId}本次意图。只结算这一动作，不续写后续选择。条件不满足则outcome.status=failed。\n${JSON.stringify({ intent, targetIds, ...(speech ? { speech } : {}) })}`,
        "action", actorId, { id, ...(speech ? { speech } : {}) }, c.signal, false, beforeCommit, id), c.signal);
      return outcome?.status === "completed";
    } catch (error) {
      const pending = k?.snapshot().actions[id];
      if (k && pending?.status === "pending") await k.commit({ idempotencyKey: `${id}:end`, source: "action", correlationId: id,
        operations: [{ op: "action.finish", id, status: c.signal.aborted || (error instanceof KernelError && error.code === "CANCELLED") ? "cancelled" : "failed", reason: String(error) }] });
      throw error;
    } finally { this.controllers.delete(id); signal?.removeEventListener("abort", abort); lifetime.removeEventListener("abort", abort); }
  }
  private async until(at: number, signal: AbortSignal): Promise<void> {
    while (this.clock.now() < at) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(1, Math.min(1000, this.clock.realMsUntil(at))));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
  }
  async evolve(reason: string): Promise<void> {
    await this.ensure(); const signal = this.lifetime.signal;
    await this.serial(async () => { await this.change(reason, "evolve", undefined, undefined, signal); }, signal);
  }
  async arrive(actorId: string, name: string, _persona: string, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    await abortable(this.ensure(), combined);
    await this.serial(async () => {
      const k = await this.kernel(); const snapshot = k.snapshot(); const existing = snapshot.entities[actorId];
      if (existing?.location) return;
      const room = snapshot.entities.bot!.location;
      await k.commit({ idempotencyKey: `visitor:arrive:${randomUUID()}`, source: "visitor", operations: existing
        ? [{ op: "move", id: actorId, location: room }]
        : [{ op: "create", entity: { id: actorId, kind: "actor", name, controller: "player", location: room, attributes: {} } }] }, { signal: combined });
    }, combined);
  }
  async leave(actorId: string): Promise<void> {
    this.cancel(actorId);
    await Promise.allSettled([...this.active].filter(([id]) => id.startsWith(`${actorId}:`)).map(([, entry]) => entry.promise));
    await this.serial(async () => {
      const k = await this.kernel(); const snapshot = k.snapshot();
      if (snapshot.entities[actorId]?.location) await k.commit({ idempotencyKey: `visitor:leave:${randomUUID()}`, source: "visitor",
        expectedVersions: { [actorId]: snapshot.entities[actorId]!.revision }, operations: [{ op: "move", id: actorId, location: null }] });
    });
  }
  private async change(task: string, source: string, actorId?: string, finish?: Finish, signal?: AbortSignal, initializing = false, beforeCommit?: () => boolean, correlationId: string = randomUUID()): Promise<Outcome | undefined> {
    const k = await this.kernel();
    const worldDefinition = await this.files.readText(this.files.worldDef);
    const messages: ChatMessage[] = [{ role: "system", content: this.prompts.world.adjudicationSystem + (initializing ? "\n" + INITIALIZATION_RULES : "") + "\n以下是创作者的世界规则与风格约束；它们指导裁定，不代表已经发生的事件。位置、物品与现状仍以结构化快照为准。\n<authored_world_rules>\n" + worldDefinition + "\n</authored_world_rules>" }];
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted(); const snapshot = k.snapshot();
      messages.push({ role: "user", content: JSON.stringify({ task, time: this.clock.now(), snapshot }) });
      const result = await abortable(this.infer(messages, [worldProposalTool(initializing)], signal), signal);
      signal?.throwIfAborted();
      const call = result.toolCalls.length === 1 ? result.toolCalls[0] : undefined;
      messages.push({ role: "assistant", content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
      try {
        if (!call || call.function.name !== "propose_world") throw new Error("World must return exactly one propose_world transaction");
        const input = JSON.parse(call.function.arguments) as { operations?: unknown; outcome?: Outcome };
        const ops = parseOperations(input?.operations);
        const outcome = input.outcome;
        if (finish && (!outcome || !["completed", "failed"].includes(outcome.status) || (outcome.reason !== undefined && typeof outcome.reason !== "string"))) throw new Error("Action requires an explicit completed/failed outcome");
        if (finish && !ops.length && !outcome?.reason) throw new Error("An action with no state changes must explain its outcome");
        if (!finish && !ops.length && !initializing) return undefined;
        const literalSpeech: WorldOperation[] = finish?.speech && outcome?.status === "completed" ? [{ op: "say", actorId: actorId!, text: finish.speech }] : [];
        const terminal: WorldOperation[] = finish ? [{ op: "action.finish", id: finish.id, status: outcome!.status, ...(outcome?.reason ? { reason: outcome.reason } : {}) }] : [];
        const proposal: TransactionProposal = { idempotencyKey: `${correlationId}:commit`, source, correlationId, ...(actorId ? { actorId } : {}),
          expectedVersions: Object.fromEntries(Object.values(snapshot.entities).map(entity => [entity.id, entity.revision])), operations: [...literalSpeech, ...ops, ...terminal] };
        const prepared = k.propose(proposal);
        this.authorize(ops, snapshot, actorId, initializing);
        await k.commit(prepared, { signal, beforeCommit, ...(literalSpeech.length ? { speakerId: actorId } : {}) });
        return outcome;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof KernelError && ["CANCELLED", "JOURNAL_UNAVAILABLE"].includes(error.code)) throw error;
        const validation = { code: error instanceof KernelError ? error.code : "INVALID_PROPOSAL", message: String(error),
          ...(error instanceof KernelError && error.details ? { details: error.details } : {}) };
        debug.emit("world.tool", initializing ? "结构化迁移·提案校验失败" : "世界事务·提案校验失败", { source, attempt: attempt + 1, validation }, "warn");
        if (attempt === 2) throw error;
        const feedback = JSON.stringify({ committed: false, validation,
          instruction: "事务未提交，任何create都没有生效。下一条消息提供最新快照。请一次修正所有问题，重新提交完整operations数组；不要只提交补丁，也不要把数组编码成字符串。" +
            (initializing ? " 对照全部create.id检查每个location和owner。只补充资料有依据的实体；不建模的外层地点使用location:null，不能继续引用新的未创建父地点。actor/place删除owner。" : "") });
        if (result.toolCalls.length) {
          for (const toolCall of result.toolCalls) messages.push({ role: "tool", tool_call_id: toolCall.id, content: feedback });
        } else messages.push({ role: "user", content: feedback });
      }
    }
    return undefined;
  }
  private authorize(ops: WorldOperation[], snapshot: WorldSnapshot, actorId: string | undefined, initializing: boolean): void {
    if (initializing) {
      if (ops.some(op => op.op !== "create")) throw new Error("Initialization only permits entity creation");
      const bot = ops.find(op => op.op === "create" && op.entity.id === "bot");
      if (!bot || bot.op !== "create" || bot.entity.kind !== "actor" || bot.entity.controller !== "bot" || !bot.entity.location) throw new Error("Initialization requires actor bot, controller bot and a physical location");
      const createdPlace = ops.find(op => op.op === "create" && op.entity.id === bot.entity.location);
      const place = snapshot.entities[bot.entity.location] ?? (createdPlace?.op === "create" ? createdPlace.entity : undefined);
      if (!place || place.kind !== "place") throw new Error("The initial bot location must be a place");
    }
    const created = new Map(ops.filter(op => op.op === "create").map(op => [op.entity.id, op.entity]));
    for (const op of ops) {
      if (!op || !["create", "update", "move", "say"].includes(op.op)) throw new Error("Model cannot change action lifecycle");
      if (op.op === "create" && op.entity.kind === "actor") {
        if (op.entity.id === "bot" && initializing) continue;
        if (op.entity.controller !== "world") throw new Error("Model-created actors must be world-controlled NPCs");
      }
      if (op.op === "say") {
        const speaker = snapshot.entities[op.actorId] ?? created.get(op.actorId);
        if (!speaker || speaker.kind !== "actor" || speaker.controller !== "world") throw new Error("World cannot provide speech for a controlled actor");
      }
      if (op.op === "update") {
        if (op.changes.controller !== undefined || op.changes.name !== undefined) throw new Error("Identity changes require administrator");
        const entity = snapshot.entities[op.id];
        if (entity?.kind === "actor" && entity.controller && entity.controller !== "world") {
          const allowed = new Set(["health", "injuries", "energy", "hunger", "thirst", "temperature", "posture", "wetness", "consciousness"]);
          for (const key of Object.keys(op.changes.attributes ?? {})) if (!allowed.has(key)) throw new Error(`World cannot rewrite controlled actor attribute ${key}`);
        }
      }
      if (op.op === "move") {
        const entity = snapshot.entities[op.id];
        if (entity?.kind === "actor" && entity.controller && entity.controller !== "world" && op.id !== actorId) throw new Error("World cannot choose movement for another controlled actor");
      }
    }
  }
}

/** Reject malformed model envelopes before authorization accesses nested fields. */
function parseOperations(value: unknown): WorldOperation[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid operations array: operations must be a JSON array of at most 200 objects, not a JSON-encoded string");
  for (const [index, op] of value.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new Error(`operations[${index}] must be an operation object`);
    if (!["create", "update", "move", "say"].includes(op.op)) throw new Error(`Model cannot change action lifecycle: unsupported operations[${index}].op`);
    if (op.op === "create" && (!op.entity || typeof op.entity !== "object" || Array.isArray(op.entity))) throw new Error(`operations[${index}].entity must be an entity object`);
    if (op.op === "update" && (!op.changes || typeof op.changes !== "object" || Array.isArray(op.changes))) throw new Error(`operations[${index}].changes must be an object`);
  }
  return value as WorldOperation[];
}

/** Abort waiting promptly even if an inference adapter takes time to honor its signal. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
