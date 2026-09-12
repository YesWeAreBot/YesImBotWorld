/** Administrative mutations are permitted here only against the marked in-memory preview. */
export default async function smokeCommands({ evaluate, wait, assert, navigate }) {
  const target = await evaluate('({hostname:location.hostname,port:location.port})');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port !== '18111', 'Commands smoke requires an isolated loopback preview');
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Commands smoke requires preview marker');
  await navigate('overview');
  await wait("document.querySelectorAll('.commands-choice').length===10");
  assert(await evaluate("!document.querySelector('#nav a[href=\"#commands\"]') && !document.querySelector('.commands-page') && document.querySelector('.commands-form').hidden"), 'Commands start as compact overview buttons, with no separate page or expanded form');
  await evaluate("window.__commandFetch=window.fetch;window.__commandPosts=[];window.fetch=function(url,options){if(url==='/api/commands'&&options?.method==='POST')window.__commandPosts.push(JSON.parse(options.body));return window.__commandFetch.apply(this,arguments);};window.__commandConfirm=window.confirm;");
  const select = async name => {
    await evaluate(`Array.from(document.querySelectorAll('.commands-choice')).find(button => button.dataset.command === ${JSON.stringify(name)}).click()`);
    await wait(`document.querySelector('.commands-choice.is-selected')?.dataset.command===${JSON.stringify(name)} && !document.querySelector('.commands-form').hidden`);
  };
  const execute = () => evaluate("document.querySelector('[data-command-execute]').click()");
  try {
    await select('world.status');
    await execute();
    await wait("document.querySelector('.commands-output')?.textContent.includes('开发样本世界')");
    assert(await evaluate("window.__commandPosts.length===1 && window.__commandPosts[0].command==='world.status'"), 'Status uses the structured command API once');
    await select('world.inject');
    const content = '浏览器样本事件 <img src=x onerror=throwError()>\n保留第二行';
    await evaluate(`var field=document.querySelector('[data-command-field="text"]');field.value=${JSON.stringify(content)};field.dispatchEvent(new Event('input'));`);
    await evaluate("window.__commandDraftRef=document.querySelector('[data-command-field=\"text\"]');window.__commandDraftRef.focus();window.__commandDraftRef.setSelectionRange(3,7);window.__commandHero=document.querySelector('.studio-hero');window.dispatchEvent(new CustomEvent('studio:refresh'));");
    await wait("document.querySelector('.studio-hero')!==window.__commandHero");
    assert(await evaluate("document.querySelector('[data-command-field=\"text\"]')===window.__commandDraftRef && document.activeElement===window.__commandDraftRef && window.__commandDraftRef.selectionStart===3 && window.__commandDraftRef.selectionEnd===7"), 'Overview refresh preserves the mounted form, focus, selection and draft');
    await select('world.status'); await select('world.inject');
    assert.equal(await evaluate("document.querySelector('[data-command-field=\"text\"]').value"), content, 'Command drafts survive command selection');
    await evaluate("var button=document.querySelector('[data-command-execute]');button.click();button.click();");
    await wait("document.querySelector('.commands-output')?.textContent.includes('开发样本已接收事件')");
    assert(await evaluate("window.__commandPosts.filter(run=>run.command==='world.inject').length===1"), 'Double clicking cannot submit twice');
    assert(await evaluate("document.querySelectorAll('.commands-output img').length===0"), 'Command results are text, never executable markup');
    await select('world.reload'); await execute();
    await wait("document.querySelector('.commands-detail .commands-run-state').textContent==='执行中'");
    assert(await evaluate("document.querySelector('[data-command-execute]').disabled"), 'A running mutation disables conflicting commands');
    await wait("document.querySelector('.commands-output')?.textContent==='开发样本定义已重载。'");
    await select('world.reset');
    await evaluate("window.confirm=()=>false;window.__commandsBeforeCancel=window.__commandPosts.length");
    await execute();
    assert(await evaluate("window.__commandPosts.length===window.__commandsBeforeCancel"), 'Declining destructive confirmation sends no request');
    await evaluate("document.querySelector('.commands-history-toggle').click();document.querySelector('.commands-run[data-run-command=\"world.inject\"]').click()");
    assert(await evaluate("document.querySelector('.commands-output').textContent.includes('保留第二行')"), 'History entries are touch-selectable and preserve the full result');
    await navigate('growth'); await evaluate("Studio.navigate('commands')"); await wait("activeView === 'overview' && document.querySelector('.commands-run')");
    assert(await evaluate("location.hash==='#overview' && window.__commandPosts.length===window.__commandsBeforeCancel"), 'Legacy command links open overview and only read history; they never replay a command');
    await select('world.inject');
    assert.equal(await evaluate("document.querySelector('[data-command-field=\"text\"]').value"), content, 'Operation drafts survive leaving and returning to overview');
    return 'overview controls: compact actions, stable focused forms during refresh, retained drafts across navigation, single submission, live progress, readable receipts, touchable history and cancelled destructive confirmation';
  } finally {
    await evaluate("window.fetch=window.__commandFetch;window.confirm=window.__commandConfirm;delete window.__commandFetch;delete window.__commandPosts;delete window.__commandConfirm;delete window.__commandsBeforeCancel;delete window.__commandDraftRef;delete window.__commandHero;");
  }
}
