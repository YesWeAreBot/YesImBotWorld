/** Isolated phone app fixtures reached through the same HTTP device routes as the UI. */
export function createPhoneAppsFixture(getConfig) {
  const jobs = { assistant: [], camera: [] }, reminders = [], calls = [];
  let next = 1, elapsed = 0, started = null;
  const laps = [];
  const nowTU = () => 400 + (Date.now() - born) / 1000;
  const born = Date.now();
  const defs = {
    assistant: ['ask', 'read_reply', 'assistant.cancel', 'new_conversation'],
    camera: ['take_photo', 'read_photo', 'camera.cancel'],
    clock: ['read_clock', 'set_timer', 'set_alarm', 'list_reminders', 'cancel_reminder', 'snooze_reminder', 'stopwatch'],
  };
  const all = () => [
    { id: 'clock', name: '时钟', description: '开发样本：世界时钟与计时操作。', kind: 'app' },
    { id: 'camera', name: '相机', description: '开发样本：取景和已保存图片的前端验证，不调用图像模型。', kind: 'app' },
    { id: 'assistant', name: getConfig().apps.assistant.name || '小助手', description: '开发样本：本地流式文字，不调用模型。', kind: 'app' },
  ];
  function installed() {
    const { apps, world } = getConfig(), assistantModel = apps.assistant.mode === 'independent' ? apps.assistant : world;
    return all().filter(app => app.id === 'clock' ? apps.clockEnabled : app.id === 'camera'
      ? apps.camera.enabled && apps.camera.baseURL && apps.camera.model
      : apps.assistant.enabled && assistantModel.baseURL && assistantModel.model);
  }
  function state(id) {
    if (id === 'assistant' || id === 'camera') {
      for (const job of jobs[id]) {
        if (!['running', 'generating'].includes(job.status)) continue;
        const age = Date.now() - job.began;
        if (id === 'assistant') job.reply = age < 300 ? '开发样本：' : '开发样本：已收到「' + job.question + '」。这是手机应用中的流式回答，没有访问外部模型。';
        if (age > 1200) { job.status = 'completed'; if (id === 'camera') { job.mediaId = 71; job.galleryRef = 'gallery:照片/开发样本.svg'; } }
      }
      return { id, busy: jobs[id].some(job => ['running', 'generating'].includes(job.status)), jobs: structuredClone(jobs[id]) };
    }
    if (id !== 'clock') return null;
    return { timeLine: '星历九年 · 27时105分（开发样本）', nowTU: nowTU(), secondsPerTU: 2, calendarKind: 'custom',
      durationUnits: [{ name: '世界秒', seconds: 1 }, { name: '分', seconds: 100 }, { name: '刻', seconds: 900 }],
      alarmHint: '开发历法：一日30时，一时120分。', reminders: structuredClone(reminders),
      stopwatch: { elapsedSeconds: elapsed + (started == null ? 0 : (Date.now() - started) / 500), running: started != null, laps: [...laps] } };
  }
  return {
    installed, state, calls,
    tools: id => (defs[id] || []).map(name => ({ name, signature: name + '(...)', description: '本地开发样本操作', device: 'phone', effect: 'action', inputSchema: { type: 'object' } })),
    handles: name => Object.values(defs).flat().includes(name),
    call(name, args) {
      calls.push(structuredClone({ name, args }));
      if (name === 'ask') jobs.assistant.push({ id: 'question-' + next++, question: args.question, reply: '', status: 'running', worldTime: '星历九年 · 27时105分', began: Date.now() });
      else if (name === 'assistant.cancel') jobs.assistant.filter(job => job.status === 'running').forEach(job => { job.status = 'cancelled'; });
      else if (name === 'new_conversation') jobs.assistant.length = 0;
      else if (name === 'take_photo') jobs.camera.push({ id: 'photo-' + next++, subject: args.subject || '眼前场景', facing: args.facing, status: 'generating', began: Date.now() });
      else if (name === 'camera.cancel') jobs.camera.filter(job => !args.job_id || args.job_id === job.id).forEach(job => { if (job.status === 'generating') job.status = 'cancelled'; });
      else if (name === 'set_timer' || name === 'set_alarm') reminders.push({ id: 'reminder-' + next++, label: args.label || '开发提醒', kind: name === 'set_alarm' ? 'alarm' : 'timer', dueTU: args.at_tu ?? nowTU() + Number(args.duration_seconds || 120) / 2, status: 'scheduled' });
      else if (name === 'cancel_reminder') { const r = reminders.find(r => r.id === args.id); if (r) r.status = 'cancelled'; }
      else if (name === 'snooze_reminder') { const r = reminders.find(r => r.id === args.id); if (r) { r.dueTU = nowTU() + args.duration_seconds / 2; r.status = 'scheduled'; } }
      else if (name === 'stopwatch') {
        if (args.action === 'start' && started == null) started = Date.now();
        if (args.action === 'pause' && started != null) { elapsed += (Date.now() - started) / 500; started = null; }
        if (args.action === 'lap') laps.push(state('clock').stopwatch.elapsedSeconds);
        if (args.action === 'reset') { elapsed = 0; started = null; laps.length = 0; }
      }
      return '开发样本操作已完成，未调用模型或发送平台消息。';
    },
  };
}
