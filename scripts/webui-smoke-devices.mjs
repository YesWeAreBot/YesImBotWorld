/**
 * Device DOM smoke for scripts/preview-webui.mjs only.
 * The driver supplies an isolated browser and condition polling; no fixed sleeps,
 * real messages, external websites, processes, Docker containers or VNC sessions.
 */
export async function smokeDevices({ evaluate, wait, assert, navigate }) {
  const target = await evaluate('({hostname:location.hostname,port:location.port})');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port !== '18111',
    'Device smoke requires a loopback preview and must never target production port 18111');
  assert(await evaluate("fetch('/api/health').then(r=>r.ok?r.json():null).then(r=>r?.preview===true)"),
    'Device smoke requires the explicit preview health marker before any mutation');

  const quote = JSON.stringify;
  const check = async (expression, label) => assert(await evaluate(expression), label);
  const click = async selector => {
    await wait(`!!document.querySelector(${quote(selector)}) && !document.querySelector(${quote(selector)}).disabled`);
    await evaluate(`document.querySelector(${quote(selector)}).click()`);
  };
  const fill = async (selector, value) => {
    await evaluate(`(() => { const input=document.querySelector(${quote(selector)}); if(!input)throw Error('Missing input: '+${quote(selector)}); input.value=${quote(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  };
  const submit = async selector => {
    await wait(`!!document.querySelector(${quote(selector)}+' button[type="submit"]') && !document.querySelector(${quote(selector)}+' button[type="submit"]').disabled`);
    await evaluate(`document.querySelector(${quote(selector)}).requestSubmit()`);
  };
  const openApp = async (name, kind) => {
    await evaluate("document.querySelector('.app-back')?.click()");
    const tile = `Array.from(document.querySelectorAll('.phone-app-tile')).find(n=>n.getAttribute('aria-label')===${quote(name)})`;
    await wait(`!!(${tile}) && !(${tile}).disabled`);
    await evaluate(`(${tile}).click()`);
    await wait(`!!document.querySelector('.phone-display.app-${kind}') && !document.querySelector('[data-device-control]').disabled`);
  };
  const stamp = Date.now().toString(36);
  const message = `本地设备冒烟消息 ${stamp}`;
  const noteTitle = `设备冒烟笔记 ${stamp}`;

  await navigate('devices');
  await wait("!!document.querySelector('[data-device-control]') && !document.querySelector('[data-device-control]').disabled");
  // A reusable run may start with the previous preview already taken over.
  if (await evaluate("document.querySelector('[data-device-control]').getAttribute('aria-label')==='交还给 Bot'")) {
    await click('[data-device-control]');
    await wait("document.querySelector('[data-device-control]')?.getAttribute('aria-label')==='接管设备'");
  }
  await evaluate("document.querySelector('.app-back')?.click()");
  await check("document.querySelectorAll('.phone-app-tile').length===6 && Array.from(document.querySelectorAll('.phone-app-tile')).every(n=>n.disabled)",
    'The six fixture apps are visible and read only before takeover');
  await click('[data-device-control]');
  await wait("document.querySelector('[data-device-control]')?.getAttribute('aria-label')==='交还给 Bot' && !document.querySelector('.phone-app-tile').disabled");

  await openApp('消息', 'chat');
  await click('.app-chat-channel');
  await wait("!document.querySelector('.app-chat-send').disabled && document.querySelector('.app-chat-title').textContent.includes('本地工作室')");
  await fill('.app-chat-compose', message);
  await click('.app-chat-send');
  await wait(`Array.from(document.querySelectorAll('.app-message-self .app-message-bubble')).some(n=>n.textContent===${quote(message)})`);
  await check("document.querySelector('.app-chat-compose').value===''", 'Explicit send adds the local message and clears its draft');
  await fill('.app-chat-compose', '保留在第一个会话里的草稿');
  await click('.app-chat-channel:nth-child(2)');
  await wait("document.querySelector('.app-chat-title').textContent.includes('空白会话')");
  await check("document.querySelector('.app-chat-compose').value===''", 'Switching channels does not leak the previous draft');
  await click('.app-chat-channel:first-child');
  await wait("document.querySelector('.app-chat-compose').value==='保留在第一个会话里的草稿'");

  await openApp('天气', 'weather');
  const city = `样本城市 ${stamp}`;
  await fill('.app-weather input', city);
  await submit('.app-weather form');
  await wait(`document.querySelector('.app-weather-current')?.textContent.includes(${quote(city)})`);
  await check("document.querySelector('.app-weather-temperature strong')?.textContent==='23' && document.querySelectorAll('.app-weather-forecast>div').length===3",
    'Weather renders the fixture tool response and three forecast rows');

  await openApp('浏览器', 'browser');
  const query = `本地阅读器 ${stamp}`;
  await fill('.app-browser-address input', query);
  await submit('.app-browser-address');
  await wait(`document.querySelector('.app-browser-page').textContent.includes(${quote(query)})`);
  await check("document.querySelector('.app-browser-page').textContent.includes('不是网络搜索结果')", 'Browser displays the local reader result');

  await openApp('记事本', 'notes');
  await click('.app-notes-add');
  await fill('.app-note-editor>input', noteTitle);
  await fill('.app-note-paper', '只保存在隔离预览内存中的笔记正文。');
  await click('.app-notes-save');
  await wait("document.querySelector('.app-note-result')?.textContent.includes('已保存到本地预览内存')");
  await check(`fetch('/api/notes').then(r=>r.json()).then(r=>r.notes.some(n=>n.title===${quote(noteTitle)} && n.content==='只保存在隔离预览内存中的笔记正文。'))`,
    'The notes editor saves through the device tool into preview storage');

  await openApp('新闻', 'news');
  await wait("document.querySelectorAll('.app-news-article').length===2");
  await click('.app-news-article');
  await wait("document.querySelector('.app-news .app-output').textContent.includes('文章 1')");
  await check("document.querySelector('.app-news .app-output').textContent.includes('开发样本')", 'A numbered headline opens its matching local article');

  await openApp('创意工具', 'mcp');
  await evaluate("document.querySelector('.app-tool-card').open=true");
  await fill('.app-schema-form [aria-label="作品名称"]', `表单样本 ${stamp}`);
  await fill('.app-schema-form [aria-label="style"]', '2');
  await fill('.app-schema-form [aria-label="count"]', '4');
  await fill('.app-schema-form [aria-label="include_notes"]', 'false');
  await fill('.app-schema-form [aria-label="colors"]', '["苔绿","暖白"]');
  await submit('.app-schema-form');
  await wait(`document.querySelector('.app-mcp .app-output').textContent.includes(${quote(`表单样本 ${stamp}`)})`);
  await check("(() => { const text=document.querySelector('.app-mcp .app-output').textContent; const args=JSON.parse(text.slice(text.indexOf('{'))); return args.style==='安静' && args.count===4 && args.include_notes===false && args.colors.join(',')==='苔绿,暖白' && args.options.contrast===0.5; })()",
    'MCP schema forms preserve enum, numeric, boolean, array and nested object types');

  await click('[data-device-tab="computer"]');
  await click('[data-device-tool="open_computer"]');
  await wait("!!document.querySelector('.device-terminal-prompt') && !document.querySelector('.device-terminal-run').disabled");
  await fill('.device-terminal-prompt input', `echo preview-${stamp}`);
  await submit('.device-terminal-prompt');
  await wait(`document.querySelector('.device-terminal-log').textContent.includes(${quote(`echo preview-${stamp}`)}) && document.querySelector('.device-terminal-log').textContent.includes('未执行真实命令')`);
  await check("document.querySelector('.device-terminal-status').textContent.includes('容器运行中')", 'The fixture terminal updates its status and displays the unexecuted command receipt');

  await click('[data-device-control]');
  await wait("document.querySelector('[data-device-control]')?.getAttribute('aria-label')==='接管设备'");
  await check("document.querySelector('.device-terminal-run').disabled && Array.from(document.querySelectorAll('[data-device-mutation]')).every(n=>n.disabled)",
    'Handing control back disables all device mutation controls');
  return 'devices: takeover, six apps, local messages, draft isolation, notes, typed schema, terminal and handback';
}

export default smokeDevices;
