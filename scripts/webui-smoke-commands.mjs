/** Administrative mutations are permitted here only against the marked in-memory preview. */
export default async function smokeCommands({ evaluate, wait, assert, navigate }) {
  const target = await evaluate('({hostname:location.hostname,port:location.port})');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port !== '18111', 'Commands smoke requires an isolated loopback preview');
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Commands smoke requires preview marker');
  await navigate('overview');
  await wait("document.querySelectorAll('.commands-choice').length===8");
  assert(await evaluate("!document.querySelector('#nav a[href=\"#commands\"]') && !document.querySelector('.commands-panel,.studio-overview-commands') && !document.querySelector('.commands-popover').open && !!document.querySelector('.studio-hero-actions > .commands-menu > .commands-more')"), 'More belongs to the welcome actions, without a separate operations panel');
  assert(await evaluate("!document.querySelector('.commands-choice[data-command=\"world.start\"],.commands-choice[data-command=\"world.stop\"]')"), 'More does not duplicate the existing world start/pause button');
  await evaluate("window.__commandFetch=window.fetch;window.__commandPosts=[];window.fetch=function(url,options){if(url==='/api/commands'&&options?.method==='POST')window.__commandPosts.push(JSON.parse(options.body));return window.__commandFetch.apply(this,arguments);};window.__commandConfirm=window.confirm;");
  const menu = async () => {
    await evaluate("if(!document.querySelector('.commands-popover').open)document.querySelector('.commands-more').click();if(document.querySelector('.commands-catalog').hidden)document.querySelector('.commands-back').click();");
    await wait("document.querySelector('.commands-popover').open && !document.querySelector('.commands-catalog').hidden");
  };
  const choose = async name => {
    await menu();
    await evaluate(`document.querySelector('.commands-choice[data-command="${name}"]').click()`);
  };
  const execute = () => evaluate("document.querySelector('[data-command-execute]').click()");
  try {
    await choose('world.status');
    await wait("document.querySelector('.commands-output')?.textContent.includes('开发样本世界')");
    assert(await evaluate("window.__commandPosts.length===1 && window.__commandPosts[0].command==='world.status' && document.querySelector('.commands-form').hidden"), 'A no-argument menu action executes on one click without a submit form');
    await choose('world.inject');
    const content = '浏览器样本事件 <img src=x onerror=throwError()>\n保留第二行';
    await wait("!document.querySelector('.commands-form').hidden");
    await evaluate(`var field=document.querySelector('[data-command-field="text"]');field.value=${JSON.stringify(content)};field.dispatchEvent(new Event('input'));`);
    await evaluate("window.__commandDraftRef=document.querySelector('[data-command-field=\"text\"]');window.__commandDraftRef.focus();window.__commandDraftRef.setSelectionRange(3,7);window.__commandHero=document.querySelector('.studio-hero');window.__commandBody=document.querySelector('.studio-kpi-row');window.dispatchEvent(new CustomEvent('studio:refresh'));");
    await wait("document.querySelector('.studio-kpi-row')!==window.__commandBody");
    assert(await evaluate("document.querySelector('.studio-hero')===window.__commandHero && document.querySelector('.commands-popover').open && document.querySelector('[data-command-field=\"text\"]')===window.__commandDraftRef && document.activeElement===window.__commandDraftRef && window.__commandDraftRef.selectionStart===3 && window.__commandDraftRef.selectionEnd===7"), 'Overview refresh preserves the welcome DOM, open popup, focused field, selection and draft');
    await evaluate("document.querySelector('.commands-close').click()");
    assert(await evaluate("!document.querySelector('.commands-popover').open && document.activeElement===document.querySelector('.commands-more')"), 'Closing returns keyboard focus to More');
    await evaluate("document.querySelector('.commands-more').click()");
    assert.equal(await evaluate("document.querySelector('[data-command-field=\"text\"]').value"), content, 'Collapsing More preserves the draft');
    await choose('world.travel'); await choose('world.inject');
    assert.equal(await evaluate("document.querySelector('[data-command-field=\"text\"]').value"), content, 'Command drafts survive switching operations');
    await evaluate("var button=document.querySelector('[data-command-execute]');button.click();button.click();");
    await wait("document.querySelector('.commands-output')?.textContent.includes('开发样本已接收事件')");
    assert(await evaluate("window.__commandPosts.filter(run=>run.command==='world.inject').length===1"), 'Double clicking cannot submit twice');
    assert(await evaluate("document.querySelectorAll('.commands-output img').length===0"), 'Command results are text, never executable markup');
    await choose('world.reload');
    await wait("document.querySelector('.commands-detail .commands-run-state').textContent==='执行中'");
    await menu();
    assert(await evaluate("document.querySelector('[data-command=\"world.reload\"]').disabled && !document.querySelector('[data-command=\"world.status\"]').disabled"), 'A running mutation disables conflicting menu actions while reads remain available');
    await evaluate("document.querySelector('.commands-history-toggle').click()");
    await wait("document.querySelector('.commands-output')?.textContent==='开发样本定义已重载。'");
    await evaluate("window.confirm=()=>false;window.__commandsBeforeCancel=window.__commandPosts.length");
    await choose('world.reset');
    assert(await evaluate("window.__commandPosts.length===window.__commandsBeforeCancel && !document.querySelector('.commands-catalog').hidden"), 'Declining a destructive menu action sends no request and keeps the menu open');
    await evaluate("document.querySelector('.commands-history-toggle').click();document.querySelector('.commands-run[data-run-command=\"world.inject\"]').click()");
    assert(await evaluate("document.querySelector('.commands-output').textContent.includes('保留第二行')"), 'History entries are touch-selectable and preserve the full result');
    await evaluate("var popup=document.querySelector('.commands-popover');popup.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0,bubbles:true}))");
    assert(await evaluate("!document.querySelector('.commands-popover').open && document.querySelector('.commands-more').getAttribute('aria-expanded')==='false'"), 'Clicking outside the dialog dismisses More');
    await navigate('growth'); await evaluate("Studio.navigate('commands')"); await wait("activeView === 'overview' && document.querySelector('.commands-run')");
    assert(await evaluate("location.hash==='#overview' && window.__commandPosts.length===window.__commandsBeforeCancel && !document.querySelector('.commands-popover').open"), 'Legacy links open overview with More collapsed and never replay a command');
    await choose('world.inject');
    assert.equal(await evaluate("document.querySelector('[data-command-field=\"text\"]').value"), content, 'Operation drafts survive leaving and returning to overview');
    await evaluate("document.querySelector('.commands-close').click()");
    return 'overview More: integrated welcome actions, no duplicate controls, one-click commands, retained modal drafts and focus during refresh/navigation, direct receipts, safe confirmations and dismissal';
  } finally {
    await evaluate("window.fetch=window.__commandFetch;window.confirm=window.__commandConfirm;delete window.__commandFetch;delete window.__commandPosts;delete window.__commandConfirm;delete window.__commandsBeforeCancel;delete window.__commandDraftRef;delete window.__commandHero;delete window.__commandBody;");
  }
}
