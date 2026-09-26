/** Exercise the independent growth model form against the ephemeral preview only. */
export default async function smokeLlmConfig({ evaluate, wait, assert, navigate, page }) {
  await page('Emulation.setDeviceMetricsOverride', { width:375,height:1000,deviceScaleFactor:1,mobile:true });
  await navigate('config'); await evaluate("gotoCfg('bot')");
  await wait("document.querySelector('[data-config-group=\"bot.growth.llm\"]')");
  await evaluate("window.__llmConfigOriginal=JSON.parse(JSON.stringify(cfgCache));window.__setLlmMode=function(group,value){var s=document.querySelector('[data-config-path=\"bot.'+group+'.llm.mode\"]');s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));};");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"等待工具结果\"]')?.checked && ['blockingAct','sendBlocking'].every(key=>document.querySelector('[data-config-path=\"bot.'+key+'\"]').disabled)"), 'Strict tool-result waiting is visible among primary settings; inactive parallel policies are disabled');
  await evaluate("document.querySelector('[data-config-path=\"bot.strictToolLoop\"]').click();var action=document.querySelector('[data-config-path=\"bot.blockingAct\"]');action.checked=false;action.dispatchEvent(new Event('change',{bubbles:true}));");
  assert.ok(await evaluate("cfgCache.bot.strictToolLoop===false && ['blockingAct','sendBlocking'].every(key=>!document.querySelector('[data-config-path=\"bot.'+key+'\"]').disabled) && cfgCache.bot.blockingAct===false && cfgCache.bot.sendBlocking===true"), 'Disabling strict waiting exposes independent action and send policies');
  await evaluate("document.querySelector('[data-config-path=\"bot.strictToolLoop\"]').click()");
  assert.ok(await evaluate("cfgCache.bot.strictToolLoop===true && cfgCache.bot.blockingAct===false && document.querySelector('[data-config-path=\"bot.blockingAct\"]').disabled"), 'Re-enabling strict mode preserves the concurrent policy draft');
  assert.ok(await evaluate("['growth'].every(group=>document.querySelector('[data-llm-independent=\"bot.'+group+'.llm\"]').hidden && !document.querySelector('[data-llm-inherit-note=\"bot.'+group+'.llm\"]').hidden)"), 'Growth defaults to clear inheritance without exposing inactive fields');
  for (const group of ['growth']) {
    await evaluate(`window.__setLlmMode(${JSON.stringify(group)},'independent');var base=document.querySelector('[data-config-path="bot.${group}.llm.baseURL"]');base.value=location.origin+'/fixture-${group}/v1';base.dispatchEvent(new Event('input',{bubbles:true}));var key=document.querySelector('[data-config-path="bot.${group}.llm.apiKey"]');key.value=${JSON.stringify('fixture-growth-ui-key')};key.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-model-list="bot.${group}.llm.model"]').click();`);
    await wait(`document.querySelector('#modal.show #modal-body select')?.value===${JSON.stringify(`bot-${group}-llm-model-a`)}`);
    assert.equal(await evaluate("document.querySelector('#modal-body select').value"),`bot-${group}-llm-model-a`);
    await evaluate("document.querySelector('#modal-body .primary').click()");
  }
  const calls = await evaluate("api('GET','/api/preview/llm/requests').then(value=>value.requests.slice(-1))");
  assert.deepEqual(calls.map(item=>item.group), ['bot.growth.llm']);
  assert.deepEqual(calls.map(item=>item.apiKey), ['fixture-growth-ui-key']);
  assert.ok(calls[0].baseURL.endsWith('/fixture-growth/v1'));
  assert.ok(await evaluate("cfgCache.bot.growth.llm.model==='bot-growth-llm-model-a' && cfgCache.bot.model===window.__llmConfigOriginal.bot.model"), 'Model selection writes only the selected auxiliary group');
  await evaluate("window.__llmDraft=document.querySelector('[data-config-path=\"bot.growth.llm.baseURL\"]');window.__setLlmMode('growth','inherit');var main=document.querySelector('[data-config-path=\"bot.model\"]');main.focus();main.value='fixture-main-updated';main.dispatchEvent(new Event('input',{bubbles:true}));");
  assert.ok(await evaluate("document.querySelector('[data-llm-inherit-note=\"bot.growth.llm\"]').textContent.includes('fixture-main-updated') && document.activeElement===document.querySelector('[data-config-path=\"bot.model\"]') && document.querySelector('[data-llm-independent=\"bot.growth.llm\"]').hidden"), 'Inherited model summary updates without rebuilding the active main-model input');
  await evaluate("window.__setLlmMode('growth','independent')");
  assert.ok(await evaluate("window.__llmDraft===document.querySelector('[data-config-path=\"bot.growth.llm.baseURL\"]') && !window.__llmDraft.disabled && window.__llmDraft.value.endsWith('/fixture-growth/v1')"), 'Switching modes preserves controls and independent drafts');
  await evaluate("cfgCache.bot.growth.llm.apiKey='******';renderCfgBody()");
  assert.ok(await evaluate("document.querySelector('[data-config-path=\"bot.growth.llm.apiKey\"]').value==='' && document.querySelector('[data-config-path=\"bot.growth.llm.apiKey\"]').placeholder.includes('已设置')"), 'A stored key is represented by a placeholder, never copied into the field');
  await evaluate("document.querySelector('[aria-label=\"清除 bot.growth.llm.apiKey 的密钥\"]').click();document.querySelector('.cfg-savebar .primary').click()");
  await wait('!cfgDirty');
  assert.ok(await evaluate("api('GET','/api/config').then(result=>result.value.bot.growth.llm.apiKey==='' && result.value.bot.growth.llm.mode==='independent')"), 'Independent credentials can be explicitly cleared and group settings use the normal save path');
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Nested model forms fit the mobile viewport');
  await evaluate("cfgCache=window.__llmConfigOriginal;markCfgDirty();saveConfig();delete window.__llmConfigOriginal;delete window.__setLlmMode;delete window.__llmDraft;"); await wait('!cfgDirty');
  return 'independent Growth model form, inherited summaries, scoped lists, masked-key clearing, mobile layout and stable drafts';
}
