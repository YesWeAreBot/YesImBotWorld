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
  await evaluate("window.__noteEditor=document.querySelector('.app-note-paper');__noteEditor.value='手机输入法中尚未保存的草稿';__noteEditor.dispatchEvent(new Event('input',{bubbles:true}));__noteEditor.focus();__noteEditor.dispatchEvent(new CompositionEvent('compositionstart',{data:'草'}));");
  await setOrder('created');
  assert(await evaluate("document.querySelector('.app-note-paper')===__noteEditor && document.activeElement===__noteEditor && __noteEditor.value==='手机输入法中尚未保存的草稿'"), 'Sorting does not remount an editor or restart its input method');
  // Another actor changes a different note; the list updates while this editor keeps its unsaved draft.
  await evaluate("api('POST','/api/device/tool',{name:'edit_note',args:{title:'一些界面想法',content:'后台改动的样本'},mode:'stealth'}).then(r=>{if(!r.ok)throw Error(r.text);window.dispatchEvent(new CustomEvent('studio:refresh',{detail:{channel:'file',file:'notes'}}));})");
  await wait("Array.from(document.querySelectorAll('.app-note-row')).some(n=>n.textContent.includes('后台改动的样本'))");
  assert(await evaluate("document.querySelector('.app-note-paper')===__noteEditor && document.activeElement===__noteEditor && __noteEditor.value==='手机输入法中尚未保存的草稿'"), 'Live note refresh preserves the focused editor and composition draft');
  await evaluate("__noteEditor.dispatchEvent(new CompositionEvent('compositionend',{data:'草'}));delete window.__noteEditor");
  const bounds = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})");
  assert(bounds.scroll <= bounds.width + 1, 'Phone notebook controls and timestamps do not overflow horizontally');
  return 'notes timestamps, separate clock domains, both descending orders, shared preference and persistent editor through sorting/live refresh';
}
