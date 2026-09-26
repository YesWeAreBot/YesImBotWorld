/** Scheduler results are separate from transport/model success; no live world is touched. */
export default async function smokeHeartbeat({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Heartbeat smoke requires the isolated preview');
  const publish = async (stage, heartbeat) => {
    await evaluate(`window.dispatchEvent(new CustomEvent('studio:debug',{detail:{kind:'world.task',label:'本地心跳样本',detail:${JSON.stringify(JSON.stringify({ task: 'tingle', stage, heartbeat }))}}}))`);
    await wait(`document.querySelector('.live-heartbeat')?.dataset.phase===${JSON.stringify(heartbeat.phase)}`);
  };
  const state = { phase: 'scheduled', mode: 'auto', intervalTU: 30, nextAtTU: 430, consecutiveFailures: 0, quietStreak: 0, lastOutcome: null, error: null };
  await evaluate("window.__heartbeatOriginal=lastOverview?.heartbeat");
  try {
    await navigate('overview');
    await evaluate(`window.dispatchEvent(new CustomEvent('studio:overview',{detail:{heartbeat:${JSON.stringify(state)}}}))`);
    await wait("!document.querySelector('.live-compact .live-heartbeat')?.hidden && document.querySelector('.live-heartbeat').textContent.includes('下次 430 TU')");
    await navigate('live');
    await publish('start', { ...state, phase: 'running', nextAtTU: null });
    assert(await evaluate("document.querySelector('.live-heartbeat').textContent.includes('等待本轮世界裁定') && !document.querySelector('.live-heartbeat').textContent.includes('已校验并提交')"), 'A running heartbeat is awaiting its world result even if a model call is complete');
    await publish('quiet', { ...state, intervalTU: 45, nextAtTU: 445, quietStreak: 1, lastOutcome: { status: 'quiet', finishedAtTU: 400, reason: '没有新的外部变化' } });
    await wait("document.querySelector('.live-heartbeat').textContent.includes('无新变化')");
    assert(await evaluate("document.querySelector('.live-heartbeat').textContent.includes('间隔 45 TU') && !document.querySelector('.live-heartbeat').textContent.includes('已校验并提交')"), 'Quiet completion reports its slower schedule without claiming a commit');
    await publish('failed', { ...state, phase: 'failed', intervalTU: 120, nextAtTU: 520, consecutiveFailures: 2, error: '校验失败 <img src=x onerror=alert(1)>', lastOutcome: { status: 'failed', finishedAtTU: 400 } });
    await wait("document.querySelector('.live-heartbeat').textContent.includes('连续失败 2 次')");
    assert(await evaluate("document.querySelector('.live-heartbeat').textContent.includes('下次 520 TU') && !document.querySelector('.live-heartbeat img')"), 'Failure shows the scheduled retry and safely renders diagnostic text');
    await publish('yielded', { ...state, lastOutcome: { status: 'yielded', reason: '优先处理角色行动', finishedAtTU: 401 } });
    await wait("document.querySelector('.live-heartbeat').textContent.includes('让位，未提交')");
    assert(await evaluate("!document.querySelector('.live-heartbeat').textContent.includes('连续失败') && !document.querySelector('.live-heartbeat').textContent.includes('失败后')"), 'Yield is visible without being presented as failure');
    await publish('committed', { ...state, lastOutcome: { status: 'committed', sequence: 61, perceptions: 3, attempts: 2, finishedAtTU: 402 } });
    await wait("document.querySelector('.live-heartbeat').textContent.includes('已校验并提交')");
    assert(await evaluate("document.querySelector('.live-heartbeat').textContent.includes('提交序号 61') && document.querySelector('.live-heartbeat').textContent.includes('3 条感知')"), 'Only the validated committed outcome displays the sequence and perception count');
    await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1050, deviceScaleFactor: 1, mobile: true });
    assert(await evaluate('document.documentElement.scrollWidth<=375 && innerWidth<=375'), 'The heartbeat status stays inside the mobile viewport');
    await publish('stopped', { ...state, phase: 'stopped', nextAtTU: null });
    assert(await evaluate("document.querySelector('.live-heartbeat-title').textContent.includes('已停止') && !document.querySelector('.live-heartbeat-detail').textContent.includes('下次')"), 'A stopped heartbeat has no next scheduled time');
  } finally {
    await evaluate("window.dispatchEvent(new CustomEvent('studio:overview',{detail:{heartbeat:window.__heartbeatOriginal}}));delete window.__heartbeatOriginal");
  }
  return 'heartbeat visibility: overview/live scheduler state, quiet/yield/commit distinction, bounded retry details, safe diagnostics and mobile layout';
}
