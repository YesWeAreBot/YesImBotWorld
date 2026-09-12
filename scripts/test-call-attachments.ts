/** Captured files are local previews, never a fetch or an HTML document. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
class Node {
  children: Node[] = []; parent: Node | null = null; className = ''; open = false; type = ''; value = ''; private ownText = '';
  events: Record<string, Array<() => void>> = {}; attrs: Record<string, string> = {}; src = ''; href = ''; download = ''; onclick?: (event?: any) => void;
  tagName: string; constructor(tagName: string) { this.tagName = tagName; }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_: string) { throw new Error('Attachment content cannot enter an HTML parser'); }
  appendChild(child: Node) { child.remove(); this.children.push(child); child.parent = this; return child; }
  append(...children: Node[]) { children.forEach(child => this.appendChild(child)); }
  prepend(child: Node) { child.remove(); this.children.unshift(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(type: string, fn: () => void) { (this.events[type] ||= []).push(fn); }
  emit(type: string) { (this.events[type] || []).forEach(fn => fn()); }
  showModal() { this.open = true; } close() { this.open = false; this.emit('close'); }
  focus() {} select() {}
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const cls = (node: Node, name: string) => all(node).filter(item => item.className.split(' ').includes(name));
const body = new Node('body'), refs: Blob[] = [], revoked: string[] = [], window: any = {};
const sandbox: any = { window, TextEncoder, Blob, atob, Uint8Array,
  URL: { createObjectURL(value: Blob) { refs.push(value); return 'blob:fixture-' + refs.length; }, revokeObjectURL(value: string) { revoked.push(value); } },
  document: { createElement: (tag: string) => new Node(tag), body }, navigator: {},
};
vm.runInNewContext(readFileSync('src/webui/client/readable.js', 'utf8'), sandbox); sandbox.ReadableData = window.ReadableData;
vm.runInNewContext(readFileSync('src/webui/client/attachments.js', 'utf8'), sandbox);
const api = sandbox.CallAttachments, renderer = api.create();
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=';
async function main() {
  const picture = renderer.render({ type: 'image_url', image_url: { url: png } });
  assert.equal(cls(picture, 'call-attachment-thumbnail').length, 1);
  assert.ok(!picture.textContent.includes('iVBOR'));
  assert.ok(all(picture).find(node => node.tagName === 'img')!.src.startsWith('blob:'));
  cls(picture, 'call-attachment-thumbnail')[0].onclick!();
  assert.equal(body.children[0].tagName, 'dialog'); assert.equal(body.children[0].open, true);
  all(body.children[0]).find(node => node.tagName === 'button')!.onclick!();
  assert.equal(body.children.length, 0, 'Close removes the image dialog');

  const remote = renderer.render({ type: 'input_image', image_url: 'https://example.invalid/private.png' });
  assert.ok(!all(remote).some(node => ['img', 'audio', 'iframe'].includes(node.tagName)), 'Inspecting remote attachment does not start network activity');
  assert.equal(all(remote).find(node => node.tagName === 'a')!.href, 'https://example.invalid/private.png');
  const native = renderer.render({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.split(',')[1] } });
  assert.equal(cls(native, 'call-attachment-thumbnail').length, 1);
  const audio = renderer.render({ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } });
  assert.equal(all(audio).filter(node => node.tagName === 'audio').length, 1);

  const markup = '<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script></svg>';
  const svg = renderer.render({ type: 'input_file', filename: '../../unsafe\nname.svg', file_data: 'data:image/svg+xml;base64,' + Buffer.from(markup).toString('base64') });
  assert.ok(!all(svg).some(node => ['img', 'iframe', 'object', 'embed', 'script', 'svg'].includes(node.tagName)), 'SVG and HTML are never embedded as executable documents');
  assert.equal(all(svg).find(node => node.tagName === 'a')!.download, 'unsafe_name.svg');
  const text = cls(svg, 'call-attachment-text')[0]; text.open = true; text.emit('toggle');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(text.textContent.includes(markup), 'Unsafe markup can be inspected as literal text');
  const file = renderer.render({ type: 'file', file: { filename: 'note.txt', file_data: 'data:text/plain;base64,' + Buffer.from('你好，世界').toString('base64') } });
  assert.equal(all(file).find(node => node.tagName === 'a')!.download, 'note.txt');
  const pdf = renderer.render({ type: 'document', title: 'paper.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } });
  assert.ok(pdf.textContent.includes('application/pdf'));
  assert.equal(all(pdf).filter(node => ['iframe', 'object', 'embed'].includes(node.tagName)).length, 0);
  assert.ok(renderer.render({ type: 'input_file', file_id: 'file-123' }).textContent.includes('file-123'));
  assert.ok(renderer.render('data:image/png;base64,***').textContent.includes('编码不完整或无效'));

  const source = JSON.stringify({ observation: { content: [{ type: 'image_url', image_url: { url: png } }, { type: 'text', text: '截图附件' }] } });
  const structured = window.ReadableData.render(source, { openDepth: 6, raw: false, copy: false, renderSpecial: renderer.render });
  assert.equal(cls(structured, 'call-attachment').length, 1, 'JSON encoded observations also render attachments');
  assert.ok(!structured.textContent.includes('iVBOR'));
  const readable = window.ReadableData.text(api.redact(source));
  assert.ok(readable.includes('附件：')); assert.ok(!readable.includes('iVBOR'));
  assert.equal(window.ReadableData.rawText(source), source, 'Raw request bytes retain the full attachment');
  const inline = renderer.render('截图： ![test](' + png + ') 请看上面的场景。');
  assert.ok(inline.textContent.includes('请看上面的场景')); assert.ok(!inline.textContent.includes('iVBOR'));
  assert.equal(cls(inline, 'call-attachment').length, 1);
  assert.equal(api.redact('9007199254740993'), '9007199254740993');
  cls(picture, 'call-attachment-thumbnail')[0].onclick!();
  renderer.clear(); assert.equal(body.children.length, 0);
  assert.equal(revoked.length, refs.length, 'Disposing a reading view releases every local Blob URL');
  console.log('PASS call attachments: local thumbnails and zoom, typed files/audio, safe text, no remote fetch, nested data, raw fidelity and disposal');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
