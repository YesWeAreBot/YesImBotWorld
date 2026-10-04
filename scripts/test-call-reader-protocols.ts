/** Actual call reader + attachment renderer with a minimal offline DOM, without a live browser/model. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Node {
  children: Node[] = []; parent: Node | null = null; className = ''; open = false; hidden = false;
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; events: Record<string, Array<() => void>> = {};
  src = ''; href = ''; private text = '';
  constructor(readonly tagName: string) {}
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('captured traffic must never enter an HTML parser'); }
  appendChild(child: Node) { child.remove(); this.children.push(child); child.parent = this; return child; }
  append(...children: Node[]) { children.forEach(child => this.appendChild(child)); }
  prepend(child: Node) { child.remove(); this.children.unshift(child); child.parent = this; }
  replaceChildren(...children: Node[]) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  contains(child: Node | null): boolean { return child === this || this.children.some(node => node.contains(child)); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(name: string, fn: () => void) { (this.events[name] ||= []).push(fn); }
  emit(name: string) { (this.events[name] || []).forEach(fn => fn()); }
  focus() {} select() {} showModal() { this.open = true; } close() { this.open = false; this.emit('close'); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const cls = (node: Node, name: string) => all(node).filter(value => value.className.split(' ').includes(name));
const body = new Node('body'), window: any = { getSelection: () => null }; let blobCount = 0;
const sandbox: any = { window, TextEncoder, Blob, atob, Uint8Array, navigator: {},
  document: { body, createElement: (name: string) => new Node(name), createDocumentFragment: () => new Node('fragment'), createTextNode: (text: string) => { const node = new Node('text'); node.textContent = text; return node; } },
  URL: { createObjectURL: () => 'blob:fixture-' + (++blobCount), revokeObjectURL() {} },
  fetch() { throw new Error('reader must never fetch captured URLs'); },
  el(name: string, attrs: any = {}, children: Node[] = []) {
    const node: any = new Node(name);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'cls') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (['open', 'hidden'].includes(key)) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children); return node;
  },
};
vm.runInNewContext(readFileSync('src/webui/client/readable.js', 'utf8'), sandbox); sandbox.ReadableData = window.ReadableData;
vm.runInNewContext(readFileSync('src/webui/client/call-content.js', 'utf8'), sandbox); sandbox.CallContent = window.CallContent;
vm.runInNewContext(readFileSync('src/webui/client/attachments.js', 'utf8'), sandbox);
vm.runInNewContext(readFileSync('src/webui/client/call-reader.js', 'utf8'), sandbox);
const api = sandbox.CallReader, container = new Node('div'), reader = api.create(container);
const png = 'data:image/png;base64,QUFB';
reader.request(JSON.stringify({ system: [{ type: 'text', text: '系统规则' }], messages: [
  { role: 'assistant', content: [{ type: 'text', text: '调用前' }, { type: 'tool_use', id: 'native-call', name: 'read', input: { id: 'book' } }, { type: 'text', text: '调用后' }] },
  { role: 'user', content: [{ type: 'text', text: '结果之前' }, { type: 'tool_result', tool_use_id: 'native-call', content: [{ type: 'text', text: '原图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFB' } }] }, { type: 'text', text: '结果之后' }] },
] }), 'anthropic-request');
const cards = cls(container, 'live-message');
assert.equal(cards.length, 3);
const assistantBody = cls(cards[1]!, 'live-message-body')[0]!;
assert(assistantBody.textContent.indexOf('调用前') < assistantBody.textContent.indexOf('调用工具 · read'));
assert(assistantBody.textContent.indexOf('调用工具 · read') < assistantBody.textContent.indexOf('调用后'), 'tool use stays between its neighboring prose blocks');
const resultBody = cls(cards[2]!, 'live-message-body')[0]!;
assert(resultBody.textContent.includes('对应调用：native-call'));
assert.equal(cls(resultBody, 'call-attachment-thumbnail').length, 1, 'nested tool result images use the real local attachment renderer');
assert(!container.textContent.includes('QUFB')); assert(!reader.text().includes('QUFB'));
assert.equal(all(container).filter(node => node.tagName === 'img').every(node => node.src.startsWith('blob:')), true);

reader.request(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: png }] },
  { type: 'function_call', call_id: 'responses-call', name: 'act', arguments: '{"description":"出门"}' },
  { type: 'function_call_output', call_id: 'responses-call', output: [{ type: 'input_text', text: '回执原图' }, { type: 'input_image', image_url: png }] }] }), 'responses-request');
assert.equal(cls(container, 'call-attachment-thumbnail').length, 2);
assert(container.textContent.includes('对应调用：responses-call'));
assert(!container.textContent.includes('没有正文'), 'a native function call is displayed as a call rather than an empty prose message');

const choice = { index: 0, content: '你', reasoning: '考虑', toolCalls: [{ index: 2, id: 'native-call', name: 'send', arguments: '{"msg":' }] };
reader.response({ choices: [choice], warnings: [], metadata: {} }, 'response', { active: true });
const answer = cls(container, 'live-answer')[0], toolNode = cls(container, 'live-tool-call')[0];
reader.response({ choices: [{ ...choice, content: '你好', reasoning: '考虑好了', toolCalls: [{ ...choice.toolCalls[0], arguments: '{"msg":"你好"}' }], finishReason: 'tool_use' }], warnings: [], metadata: {} }, 'response', { active: false });
assert.equal(cls(container, 'live-answer')[0], answer); assert.equal(cls(container, 'live-tool-call')[0], toolNode, 'stream updates retain existing DOM cards');
assert.equal(cls(container, 'live-answer-text')[0]!.textContent, '你好');
assert.equal(cls(container, 'live-finish')[0]!.textContent, '结束原因 · 交给工具执行');
reader.response({ choices: [{ ...choice, finishReason: 'max_output_tokens' }], warnings: [], metadata: {} }, 'response', { active: false });
assert.equal(cls(container, 'live-finish')[0]!.textContent, '结束原因 · 达到生成长度限制');
reader.clear(); assert.equal(container.children.length, 0);
console.log('PASS native call reader: ordered tool blocks, image previews inside tool results, safe copies, stable streamed DOM and localized stop reasons');
