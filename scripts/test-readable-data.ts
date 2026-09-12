/** Exercise the browser component with a minimal DOM; no world, model or service. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Node {
  children: Node[] = []; parent: Node | null = null; className = ''; open = false; type = ''; value = ''; private ownText = '';
  events: Record<string, Array<() => void>> = {};
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_: string) { throw new Error('Structured records must never enter an HTML parser'); }
  appendChild(child: Node) { child.remove(); this.children.push(child); child.parent = this; return child; }
  append(...children: Node[]) { children.forEach(child => this.appendChild(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(type: string, fn: () => void) { (this.events[type] ||= []).push(fn); }
  emit(type: string) { (this.events[type] || []).forEach(fn => fn()); }
  focus() {} select() {}
}
function all(node: Node): Node[] { return [node, ...node.children.flatMap(all)]; }
function cls(node: Node, name: string) { return all(node).filter(item => item.className.split(' ').includes(name)); }
const window: any = {}, copied: string[] = [];
runInNewContext(readFileSync('src/webui/client/readable.js', 'utf8'), {
  window, document: { createElement: (tag: string) => new Node(tag), body: new Node('body') },
  navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
});
const reader = window.ReadableData;
async function main() {
  const unsafe = '<img src=x onerror=alert(1)> & <script>bad()</script>';
  const source = JSON.stringify({ name: 'observe', arguments: JSON.stringify({ target: unsafe, open: false, energy: 0 }), empty: null });
  const root = reader.render(source), branch = cls(root, 'readable-branch')[0];
  assert.ok(root.textContent.includes('调用参数arguments'));
  assert.ok(!root.textContent.includes(unsafe), 'Nested records start collapsed');
  branch.open = true; branch.emit('toggle');
  assert.ok(root.textContent.includes(unsafe), 'Untrusted markup is preserved as text');
  assert.ok(root.textContent.includes('否（false）'));
  assert.ok(root.textContent.includes('未设置（null）'));
  assert.ok(!all(root).some(node => ['img', 'script'].includes(node.tagName)));
  assert.equal(reader.rawText(source), source, 'Original JSON encoding must be retained');
  assert.match(reader.text(source), /调用参数（arguments）[\s\S]*目标（target）：<img/);
  assert.equal(reader.label('__proto__'), '__proto__');
  assert.equal(reader.label('constructor'), 'constructor');
  assert.ok(reader.render(JSON.parse('{"__proto__":"value"}')).textContent.includes('__proto__value'));

  const rows = Array.from({ length: 1000 }, (_, index) => 'item-' + index), state: any = {};
  let list = reader.render(rows, { raw: false, state });
  assert.equal(cls(list, 'readable-index').length, 20);
  assert.ok(all(list).length < 160, 'Large arrays must not allocate every row upfront');
  cls(list, 'readable-more')[0].emit('click');
  list = reader.render(rows, { raw: false, state });
  assert.equal(cls(list, 'readable-index').length, 40, 'Refresh retains the loaded page count');
  while (cls(list, 'readable-more').length) cls(list, 'readable-more')[0].emit('click');
  assert.equal(cls(list, 'readable-index').length, 1000);
  assert.ok(list.textContent.includes('item-999'), 'Every row remains accessible');

  const long = '字'.repeat(22000) + '完整末尾', longState = {};
  let prose = reader.render(long, { state: longState });
  assert.ok(!prose.textContent.includes('完整末尾'));
  cls(prose, 'readable-more')[0].emit('click');
  prose = reader.render(long, { state: longState });
  assert.equal(cls(prose, 'readable-prose')[0].textContent.length, 9800);
  while (cls(prose, 'readable-more').length) cls(prose, 'readable-more')[0].emit('click');
  assert.ok(prose.textContent.includes('完整末尾'));
  cls(prose, 'readable-collapse')[0].emit('click');
  assert.equal(cls(prose, 'readable-prose')[0].textContent.length, 1800, 'Complete text can be folded again');
  prose = reader.render(long, { state: longState });
  assert.equal(cls(prose, 'readable-prose')[0].textContent.length, 1800, 'Refresh preserves the folded state');
  cls(prose, 'readable-more')[0].emit('click');
  assert.equal(cls(prose, 'readable-prose')[0].textContent.length, 9800, 'Folded text can be expanded again');
  cls(prose, 'readable-expand-all')[0].emit('click');
  assert.equal(cls(prose, 'readable-prose')[0].textContent, long, 'An explicit expand-all reveals the full text at once');
  cls(prose, 'readable-collapse')[0].emit('click');
  assert.equal(cls(prose, 'readable-prose')[0].textContent.length, 1800);
  cls(prose, 'readable-button').find(node => node.textContent === '复制可读内容')!.emit('click');
  await Promise.resolve();
  assert.equal(copied.at(-1), long);

  const disclosureState: any = {}, value = { payload: { status: 'completed' } };
  let record = reader.render(value, { state: disclosureState });
  const nested = cls(record, 'readable-branch')[0]; nested.open = true; nested.emit('toggle');
  const original = cls(record, 'readable-raw')[0]; original.open = true; original.emit('toggle');
  record = reader.render({ payload: { status: 'failed', reason: 'updated' } }, { state: disclosureState });
  assert.equal(cls(record, 'readable-branch')[0].open, true);
  assert.equal(cls(record, 'readable-raw')[0].open, true);
  assert.ok(record.textContent.includes('updated'), 'Expanded records update without folding');
  const rawButton = cls(record, 'readable-button').find(node => node.textContent === '复制原始数据')!;
  rawButton.emit('click'); await Promise.resolve();
  assert.deepEqual(JSON.parse(copied.at(-1)!), { payload: { status: 'failed', reason: 'updated' } });

  const circular: any = { name: 'loop' }; circular.self = circular;
  assert.match(reader.text(circular), /循环引用/);
  assert.match(reader.rawText(circular), /循环引用/);
  assert.ok(reader.render(circular, { openDepth: 4 }).textContent.includes('循环引用'));
  assert.equal(reader.text('unfinished {"name":'), 'unfinished {"name":');
  assert.equal(reader.rawText(false), 'false');
  for (const scalarText of ['9007199254740993', 'true', 'false', 'null', '123.450', '  null  ', '"plain text"', '"null"', '"9007199254740993"', JSON.stringify(JSON.stringify('null'))]) {
    assert.equal(reader.text(scalarText), scalarText, 'String scalar copy must preserve exact text: ' + scalarText);
    const scalarView = reader.render(scalarText, { compact: true });
    assert.equal(scalarView.textContent, scalarText, 'String scalar presentation must preserve exact text: ' + scalarText);
  }
  const ids = { id: '9007199254740993', content: 'null', enabled: 'true', quoted: '"null"' };
  const idsText = reader.text(JSON.stringify(ids));
  assert.ok(idsText.includes('9007199254740993'));
  assert.ok(idsText.includes('内容（content）：null'));
  assert.ok(idsText.includes('enabled：true'));
  assert.ok(idsText.includes('quoted："null"'));
  const encodedRecord = JSON.stringify(JSON.stringify({ name: 'observe', arguments: { target: '9007199254740993' } }));
  assert.ok(reader.text(encodedRecord).includes('目标（target）：9007199254740993'), 'Encoded objects still unfold');
  assert.ok(reader.text(JSON.stringify(JSON.stringify(['null', 'true']))).includes('1. null'), 'Encoded arrays still unfold');
  console.log('PASS readable data: safe text, nested JSON, lazy complete lists/text, raw fidelity, copy and refresh state');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
