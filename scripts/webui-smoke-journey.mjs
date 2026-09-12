/**
 * Browser smoke coverage for the isolated preview-webui.mjs fixture.
 * Helpers: evaluate(expression) returns its value; wait(expression) waits until
 * truthy; assert(condition, message) throws; navigate(route) mounts that view.
 *
 * Fixture contract: /api/health returns { preview: true }; player arrive creates
 * an SSE session, hello supplies unitWorldSeconds, observe returns entities with
 * observedId handles, act emits a terminal task_result, cancel returns a receipt
 * or emits one, and leave succeeds. Debug includes completed LLM usage and linked
 * world events; usage includes nonempty byLabel/byHour/byDay and recent entries.
 * All requests go through the real preview API. The wrapper records payloads;
 * it neither manufactures responses nor performs any external operation.
 */
export async function smokeJourney({ evaluate, wait, assert, navigate }) {
  const run = (fn, args) => evaluate(`(${fn.toString()})(${JSON.stringify(args) ?? 'undefined'})`);
  const click = (label) => run((label) => {
    const button = [...document.querySelectorAll('main button')].find(node => node.textContent.trim() === label);
    if (!button || button.disabled) throw new Error(`Unavailable button: ${label}`);
    button.click();
  }, label);
  const checks = [];

  const isolated = await run(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return false;
    if (location.port === '18111') return false;
    const response = await fetch('/api/health', { cache: 'no-store' });
    return response.ok && (await response.json()).preview === true;
  });
  assert(isolated, 'Journey smoke only runs against the isolated preview fixture, never production.');

  await run(() => {
    if (window.__journeySmoke) throw new Error('Journey smoke is already running.');
    const record = window.__journeySmoke = {
      api, calls: [], savedProfile: localStorage.getItem('wui_admin_player_profile'),
    };
    api = function (method, path, body) {
      const call = { method, path, body: body === undefined ? undefined : structuredClone(body) };
      record.calls.push(call);
      call.promise = record.api(method, path, body);
      return call.promise;
    };
  });

  try {
    await navigate('player');
    // A prior invocation may have kept its crossing session while changing views.
    const existingLeave = await run(() => [...document.querySelectorAll('main button')]
      .find(node => ['离开世界', '归还控制并离场'].includes(node.textContent.trim()))?.textContent.trim());
    if (existingLeave) {
      await click(existingLeave);
      await wait(`!!document.querySelector('.journey-identity')`);
    }
    await wait(`!!document.querySelector('.journey-identity input')`);
    await click('作为独立角色入场');
    await run(() => {
      const name = document.querySelector('.journey-identity input');
      const persona = document.querySelector('.journey-persona');
      name.value = '冒烟测试旅人';
      persona.value = '仅存在于本地开发预览中的测试角色。';
      [name, persona].forEach(node => node.dispatchEvent(new Event('input', { bubbles: true })));
    });
    await click('以这个角色入场');
    await wait(`!!document.querySelector('.journey-connection.connected')`);
    await click('重新观察');
    await wait(`document.querySelectorAll('.journey-entity').length > 1`);
    assert(await run(() => !!document.querySelector('.journey-entity-self') &&
      document.querySelectorAll('.journey-two-fields select option').length > 1),
    'An observation presents the actor and observed action targets.');

    await run(() => {
      const input = (selector, value) => {
        const node = document.querySelector(selector);
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };
      input('.journey-action-input', '检查眼前的物件');
      input('.journey-speech-input', '我想仔细看看。');
      input('.journey-two-fields input', '3');
      const target = document.querySelector('.journey-two-fields select');
      target.value = target.options[target.options.length - 1].value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      window.__journeySmoke.target = target.value;
    });
    await click('提交这次行动');
    await wait(`!document.querySelector('.journey-pending') && !!document.querySelector('.journey-feed-result')`);
    assert(await run(() => {
      const call = window.__journeySmoke.calls.find(c => c.path === '/api/player/task' && c.body.kind === 'act');
      return call?.body.payload.desc === '检查眼前的物件' &&
        call.body.payload.speech === '我想仔细看看。' &&
        call.body.payload.durationWorldSeconds === 3 &&
        call.body.payload.target === window.__journeySmoke.target &&
        typeof call.body.payload.observationId === 'string' && !!call.body.payload.observationId;
    }), 'Action preserves separate intent, speech, duration, and observation handles.');
    checks.push('player arrival, observation, action payload and terminal receipt');

    // Submit, await HTTP acceptance, and cancel in one browser evaluation so the
    // fixture's delayed SSE receipt cannot race between several CDP round trips.
    await run(async () => {
      const input = document.querySelector('.journey-action-input');
      input.value = '稍等片刻再检查';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const find = text => [...document.querySelectorAll('main button')].find(node => node.textContent.trim() === text);
      find('提交这次行动').click();
      const call = window.__journeySmoke.calls.filter(c => c.path === '/api/player/task' && c.body.kind === 'act').at(-1);
      await call.promise;
      await Promise.resolve();
      const cancel = find('请求取消');
      if (!cancel || cancel.disabled) throw new Error('The pending action must expose cancellation before its delayed receipt.');
      cancel.click();
    });
    await wait(`!document.querySelector('.journey-pending')`);
    assert(await run(() => {
      const calls = window.__journeySmoke.calls;
      const act = calls.filter(c => c.path === '/api/player/task' && c.body.kind === 'act').at(-1);
      const cancel = calls.find(c => c.path === '/api/player/cancel');
      return cancel?.body.taskId === act.body.taskId && cancel.body.token === act.body.token;
    }), 'Cancellation refers to the same task and session; its final receipt clears pending state.');
    await click('离开世界');
    await wait(`!!document.querySelector('.journey-identity') && !document.querySelector('.journey-session-bar')`);
    checks.push('player cancellation receipt and leave');

    await navigate('live');
    await click('事件与图表');
    await wait(`document.querySelectorAll('.insight-event-row').length > 0 && !!document.querySelector('.insight-main-chart svg circle')`);
    await click('请求 Token');
    assert(await run(() => document.querySelector('.insight-main-chart svg')?.getAttribute('aria-label').includes('tokens')),
      'Debug switches from elapsed time to actual request token points.');
    const label = await run(() => {
      const rows = document.querySelectorAll('.insight-event-row');
      const label = rows[0].querySelector('strong')?.textContent || rows[0].textContent.split('\n')[0];
      const search = document.querySelector('.insight-search');
      search.value = label;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return label;
    });
    assert(await run(label => {
      const rows = [...document.querySelectorAll('.insight-event-row')];
      return rows.length > 0 && rows.every(row => row.textContent.includes(label));
    }, label), 'Debug search narrows the visible event stream.');
    await run(() => {
      const search = document.querySelector('.insight-search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const source = document.querySelector('select[aria-label="按来源筛选"]');
      source.value = 'transaction';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      const row = document.querySelector('.insight-event-row');
      if (!row) throw new Error('Fixture needs committed world events.');
      row.click();
    });
    assert(await run(() => !!document.querySelector('.insight-causal-links') &&
      !!document.querySelector('.insight-detail .readable-data')),
    'A world event opens its raw record and causal trace.');
    checks.push('debug token chart, search, source filter and causal detail');

    await navigate('usage');
    await wait(`!!document.querySelector('.insight-breakdown-row') && !!document.querySelector('.insight-usage-chart svg rect')`);
    const selected = await run(() => {
      const row = document.querySelector('.insight-breakdown-row');
      const label = row.querySelector('strong').textContent;
      row.click();
      return label;
    });
    assert(await run(label => {
      const rows = [...document.querySelectorAll('.insight-usage-table tbody tr')];
      return document.querySelector('.insight-filter-banner')?.textContent.includes(label) &&
        rows.length > 0 && rows.every(row => row.querySelector('td strong').textContent === label);
    }, selected), 'Usage source filtering updates actual request records.');
    await click('按日');
    assert(await run(() => !!document.querySelector('.insight-usage-chart svg rect')),
      'Daily usage renders actual token totals.');
    await click('清除筛选 ×');
    assert(await run(() => !document.querySelector('.insight-filter-banner') &&
      document.querySelectorAll('.insight-usage-table tbody tr').length > 0),
    'Clearing the usage filter restores request records.');
    checks.push('usage source filter, daily chart and clear');
    return checks;
  } finally {
    await run(() => {
      const record = window.__journeySmoke;
      if (!record) return;
      api = record.api;
      if (record.savedProfile === null) localStorage.removeItem('wui_admin_player_profile');
      else localStorage.setItem('wui_admin_player_profile', record.savedProfile);
      delete window.__journeySmoke;
    });
  }
}

export default smokeJourney;
