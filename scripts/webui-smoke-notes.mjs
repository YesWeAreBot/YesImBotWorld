/** Human notebook controls against the isolated in-memory preview only. */
export default async function smokeNotes({ evaluate, wait, assert, navigate }) {
  assert(await evaluate("location.port!=='18111' && fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Notes smoke requires an isolated preview');
  const setOrder = async order => evaluate(`(() => {const s=document.querySelector('.note-sort-select');s.value=${JSON.stringify(order)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const positions = async selector => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(n=>n.textContent)`);
  const before = (rows, a, b) => rows.findIndex(text => text.includes(a)) < rows.findIndex(text => text.includes(b));
  await evaluate("localStorage.setItem('studio_note_sort','updated')");
  await navigate('data');
  await wait("document.querySelectorAll('.data-note-row').length>=3");
  assert(before(await positions('.data-note-row'), '关于这个预览', '一些界面想法'), 'Data notebook starts with most recently edited world note');
  await setOrder('created');
  assert(before(await positions('.data-note-row'), '一些界面想法', '关于这个预览'), 'Data notebook can sort by creation instead');
  assert(await evaluate("document.querySelector('.data-note-list').textContent.includes('文件时间') && document.querySelector('.note-sort-hint').textContent.includes('另组')"), 'File timestamps are clearly distinct from world chronology');
  await evaluate("Array.from(document.querySelectorAll('.data-note-row')).find(n=>n.textContent.includes('关于这个预览')).querySelector('button').click()");
  await wait("!!document.querySelector('.data-note-editor textarea')");
  assert(await evaluate("document.querySelector('.data-note-editor .note-timestamps').textContent.includes('T=10.0') && document.querySelector('.data-note-editor .note-timestamps').textContent.includes('T=30.0')"), 'Legacy editor shows creation and last edit timestamps');
  await evaluate("window.__noteEditor=document.querySelector('.data-note-editor textarea');__noteEditor.value='网页里尚未保存的草稿';__noteEditor.focus();window.dispatchEvent(new CustomEvent('studio:refresh',{detail:{channel:'file',file:'notes'}}))");
  assert(await evaluate("document.querySelector('.data-note-editor textarea')===__noteEditor && __noteEditor.value==='网页里尚未保存的草稿' && document.activeElement===__noteEditor"), 'Data refresh keeps the open draft and focus');
  await evaluate("hideModal();delete window.__noteEditor");
  await navigate('devices');
  await wait("document.querySelectorAll('.phone-app-tile').length>0 || !!document.querySelector('.app-notes')");
  if (!await evaluate("!!document.querySelector('.app-notes')")) {
    await wait("!!Array.from(document.querySelectorAll('.phone-app-tile')).find(n=>n.getAttribute('aria-label')==='记事本' && !n.disabled)");
    await evaluate("Array.from(document.querySelectorAll('.phone-app-tile')).find(n=>n.getAttribute('aria-label')==='记事本').click()");
  }
  await wait("document.querySelectorAll('.app-note-row').length>=3");
  assert(await evaluate("document.querySelector('.app-note-sort select').value==='created'"), 'Notebook sorting preference carries between both interfaces');
  await setOrder('updated');
  assert(before(await positions('.app-note-row'), '关于这个预览', '一些界面想法'), 'Phone notebook supports last edit sorting');
  await evaluate("Array.from(document.querySelectorAll('.app-note-row')).find(n=>n.textContent.includes('关于这个预览')).click()");
  assert(await evaluate("document.querySelector('.app-note-editor .note-timestamps').textContent.includes('T=10.0')"), 'Phone editor shows stable creation time');
  assert(await evaluate("!document.querySelector('.app-note-preview').hidden && document.querySelector('.app-note-paper').hidden && document.querySelector('.app-note-editor>input').readOnly"), 'Existing notes open as Markdown reading without invoking the keyboard');
  await evaluate("Array.from(document.querySelectorAll('.app-note-mode')).find(n=>n.textContent==='编辑').click()");
  await evaluate("window.__noteEditor=document.querySelector('.app-note-paper');__noteEditor.value='手机输入法中尚未保存的草稿';__noteEditor.dispatchEvent(new Event('input',{bubbles:true}));__noteEditor.focus();__noteEditor.dispatchEvent(new CompositionEvent('compositionstart',{data:'草'}));");
  await setOrder('created');
  assert(await evaluate("document.querySelector('.app-note-paper')===__noteEditor && document.activeElement===__noteEditor && __noteEditor.value==='手机输入法中尚未保存的草稿'"), 'Sorting does not remount an editor or restart its input method');
  // Another actor changes a different note; the list updates while this editor keeps its unsaved draft.
  await evaluate("api('POST','/api/device/tool',{name:'edit_note',args:{title:'一些界面想法',content:'后台改动的样本'},mode:'stealth'}).then(r=>{if(!r.ok)throw Error(r.text);window.dispatchEvent(new CustomEvent('studio:refresh',{detail:{channel:'file',file:'notes'}}));})");
  await wait("Array.from(document.querySelectorAll('.app-note-row')).some(n=>n.textContent.includes('后台改动的样本'))");
  assert(await evaluate("document.querySelector('.app-note-paper')===__noteEditor && document.activeElement===__noteEditor && __noteEditor.value==='手机输入法中尚未保存的草稿'"), 'Live note refresh preserves the focused editor and composition draft');
  await evaluate("__noteEditor.dispatchEvent(new CompositionEvent('compositionend',{data:'草'}));delete window.__noteEditor");

  const markdown = [
    '# 学习笔记', '', '**重点**、*想法*和~~划掉~~，行内 `a < b`。', '',
    '- [x] 已完成', '- [ ] 待办', '  - 子任务', '', '1. 第一步', '2. 第二步', '',
    '> 记住这个引用。', '', '| 项目 | 金额 |', '| --- | ---: |', '| 午餐 | 20 |', '',
    '```html', '<b>保留代码</b>', 'x'.repeat(240), '```', '',
    '[参考资料](https://example.com/notes) [不能执行](javascript:alert(1))', '',
    '<img src=x onerror="window.__noteXss=true">', '<script>window.__noteXss=true</script>',
  ].join('\n');
  await evaluate(`(() => {
    document.querySelector('.app-notes-add').click();
    window.__noteEditor=document.querySelector('.app-note-paper');
    const title=document.querySelector('.app-note-editor>input');title.value='Markdown 排版检查';title.dispatchEvent(new Event('input',{bubbles:true}));
    __noteEditor.value=${JSON.stringify(markdown)};__noteEditor.dispatchEvent(new Event('input',{bubbles:true}));__noteEditor.setSelectionRange(3,8);
    Array.from(document.querySelectorAll('.app-note-mode')).find(n=>n.textContent==='预览').click();
  })()`);
  const rendered = await evaluate(`(() => {const p=document.querySelector('.app-note-preview');return {
    heading:p.querySelector('h1')?.textContent, bold:p.querySelector('strong')?.textContent,
    em:p.querySelector('em')?.textContent, del:p.querySelector('del')?.textContent,
    tasks:[...p.querySelectorAll('input')].map(n=>({checked:n.checked,disabled:n.disabled})),
    nested:!!p.querySelector('li ul li'), ordered:!!p.querySelector('ol li'), quote:p.querySelector('blockquote')?.textContent,
    table:p.querySelector('.markdown-table-scroll td')?.textContent, code:p.querySelector('pre code')?.textContent,
    link:p.querySelector('a')?.getAttribute('href'), target:p.querySelector('a')?.target,
    unsafe:!!p.querySelector('script,img,[onerror],a[href^="javascript:"]') || !!window.__noteXss
  };})()`);
  assert(rendered.heading==='学习笔记' && rendered.bold==='重点' && rendered.em==='想法' && rendered.del==='划掉', 'Markdown headings and inline formatting render as readable elements');
  assert(rendered.tasks.length===2 && rendered.tasks[0].checked && !rendered.tasks[1].checked && rendered.tasks.every(n=>n.disabled) && rendered.nested && rendered.ordered, 'Markdown task lists, nested lists and ordered lists render correctly');
  assert(rendered.quote.includes('记住') && rendered.table==='午餐' && rendered.code.includes('<b>保留代码</b>'), 'Quotes, tables and literal code render correctly');
  assert(rendered.link==='https://example.com/notes' && rendered.target==='_blank' && !rendered.unsafe, 'Markdown links work while HTML and script URLs cannot execute');
  assert(await evaluate("document.querySelector('.app-note-paper')===__noteEditor && __noteEditor.selectionStart===3 && __noteEditor.selectionEnd===8"), 'Preview preserves the source textarea and selection');
  await evaluate("Array.from(document.querySelectorAll('.app-note-mode')).find(n=>n.textContent==='编辑').click()");
  assert(await evaluate(`!__noteEditor.hidden && __noteEditor.value===${JSON.stringify(markdown)}`), 'Editing returns to the unchanged Markdown source');
  await evaluate("document.querySelector('.app-notes-save').click()");
  await wait("Array.from(document.querySelectorAll('.app-note-row')).some(n=>n.textContent.includes('Markdown 排版检查'))");
  assert(await evaluate(`api('GET','/api/notes').then(r=>r.notes.find(n=>n.title==='Markdown 排版检查')?.content===${JSON.stringify(markdown)})`), 'Saving persists original Markdown, not rendered HTML');
  await evaluate("Array.from(document.querySelectorAll('.app-note-row')).find(n=>n.textContent.includes('Markdown 排版检查')).click();delete window.__noteEditor");
  assert(await evaluate("!document.querySelector('.app-note-preview').hidden && !!document.querySelector('.app-note-preview h1')"), 'Reopening a saved note immediately renders Markdown');
  const bounds = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})");
  assert(bounds.scroll <= bounds.width + 1, 'Phone notebook controls and timestamps do not overflow horizontally');
  return 'notes Markdown reader/source switching, safe rendering, verbatim saving, timestamps, sorting and persistent editor through live refresh';
}
