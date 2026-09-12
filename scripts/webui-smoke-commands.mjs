/** Administrative mutations are permitted here only against the marked in-memory preview. */
export default async function smokeCommands({ evaluate, wait, assert, navigate }) {
  const target = await evaluate('({hostname:location.hostname,port:location.port})');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port !== '18111', 'Commands smoke requires an isolated loopback preview');
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Commands smoke requires preview marker');
  await navigate('commands');
  await wait("document.querySelectorAll('.commands-choice').length===10");
  await evaluate("window.__commandFetch=window.fetch;window.__commandPosts=[];window.fetch=function(url,options){if(url==='/api/commands'&&options?.method==='POST')window.__commandPosts.push(JSON.parse(options.body));return window.__commandFetch.apply(this,arguments);};window.__commandConfirm=window.confirm;");
  const select = async name => {
    await evaluate(`Array.from(document.querySelectorAll('.commands-choice')).find(button=>button.querySelector('code').textContent===${JSON.stringify(name)}).click()`);
    await wait(`document.querySelector('.commands-code').textContent===${JSON.stringify(name)}`);
  };
  const execute = () => evaluate("document.querySelector('[data-command-execute]').click()");
  try {
    await execute();
    await wait("document.querySelector('.commands-output')?.textContent.includes('开发样本世界')");
    assert(await evaluate("window.__commandPosts.length===1 && window.__commandPosts[0].command==='world.status'"), 'Status uses the structured command API once');
    await select('world.inject');
    const content = '浏览器样本事件 <img src=x onerror=throwError()>\n保留第二行';
    await evaluate(`var field=document.querySelector('[data-command-field="text"]');field.value=${JSON.stringify(content)};field.dispatchEvent(new Event('input'));`);
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
    await evaluate("Array.from(document.querySelectorAll('.commands-run')).find(button=>button.querySelector('code').textContent==='world.inject').click()");
    assert(await evaluate("document.querySelector('.commands-output').textContent.includes('保留第二行')"), 'History entries are touch-selectable and preserve the full result');
    await navigate('overview'); await navigate('commands'); await wait("document.querySelector('.commands-run')");
    assert(await evaluate("window.__commandPosts.length===window.__commandsBeforeCancel"), 'Returning to the page only reads history; it never replays a command');
    return 'admin commands: structured forms, retained drafts, single submission, live progress, plain-text results, touchable history and cancelled destructive confirmation';
  } finally {
    await evaluate("window.fetch=window.__commandFetch;window.confirm=window.__commandConfirm;delete window.__commandFetch;delete window.__commandPosts;delete window.__commandConfirm;delete window.__commandsBeforeCancel;");
  }
}
