/** Embedded request media is inspected locally; never contacts attachment URLs. */
export default async function smokeAttachments({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("location.port!=='18111' && fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"));
  const q = JSON.stringify, id = 'attachments_' + Date.now().toString(36);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=';
  const fileText = '附件里的完整内容😀\n' + '这是一段可下载的文本。'.repeat(7000);
  const fileData = Buffer.from(fileText).toString('base64');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__attachmentExecuted=true"><text>纯文本预览</text></svg>').toString('base64');
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  const body = JSON.stringify({ model: '本地附件样本', messages: [{ role: 'user', content: [
    { type: 'text', text: '请查看这些本地附件。' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
    { type: 'input_file', filename: '../../report.txt', file_data: 'data:text/plain;base64,' + fileData },
    { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    { type: 'file', file: { filename: 'drawing.svg', file_data: 'data:image/svg+xml;base64,' + svg } },
    { type: 'image_url', image_url: { url: 'https://attachment.invalid/must-not-fetch.png' } },
    { type: 'text', text: JSON.stringify({ attachment: { filename: 'nested.txt', mime_type: 'text/plain', base64: Buffer.from('嵌套文件').toString('base64') } }) },
  ] }] });
  await navigate('live');
  await evaluate("window.__attachmentURLs=[];window.__attachmentRevoked=[];window.__attachmentCreate=URL.createObjectURL;window.__attachmentRevoke=URL.revokeObjectURL;URL.createObjectURL=function(blob){var ref=window.__attachmentCreate.call(URL,blob);window.__attachmentURLs.push(ref);return ref};URL.revokeObjectURL=function(ref){window.__attachmentRevoked.push(ref);return window.__attachmentRevoke.call(URL,ref)}");
  await evaluate(`fetch('/api/preview/calls/step',{method:'POST',headers:{'content-type':'application/json'},body:${q(JSON.stringify({ id, action: 'begin', source: 'Bot', requestBody: body }))}}).then(r=>r.json())`);
  await wait(`document.querySelector('[data-call-id="${id}"]')`);
  await evaluate(`document.querySelector('[data-call-id="${id}"]').click();document.querySelector('.live-view-read').click();document.querySelectorAll('.live-raw-tab')[0].click()`);
  await wait("document.querySelectorAll('.call-attachment').length===7");
  await wait("document.querySelector('.call-attachment-thumbnail img')?.naturalWidth===1");
  assert(await evaluate(`!document.querySelector('.live-reading').textContent.includes(${q(png)}) && !document.querySelector('.live-reading').textContent.includes(${q(fileData.slice(0, 120))})`), 'Base64 never appears in the default request reader');
  assert.equal(await evaluate("document.querySelectorAll('.live-reading img').length"), 2, 'Only embedded raster images are automatically rendered');
  assert.equal(await evaluate("document.querySelectorAll('audio.call-attachment-audio').length"), 1);
  assert.equal(await evaluate("document.querySelector('audio.call-attachment-audio').preload"), 'none', 'Audio playback is user controlled');
  assert.equal(await evaluate("document.querySelector('a[download=\"report.txt\"]').download"), 'report.txt', 'Download names cannot contain path components');
  assert.equal(await evaluate("fetch(document.querySelector('a[download=\"report.txt\"]').href).then(r=>r.text())"), fileText, 'Download bytes retain the entire file');
  await evaluate("document.querySelector('a[download=\"report.txt\"]').closest('.call-attachment').querySelector('.call-attachment-text').open=true");
  await wait("document.querySelector('a[download=\"report.txt\"]').closest('.call-attachment').textContent.includes('附件里的完整内容')");
  assert(await evaluate("document.querySelector('a[download=\"report.txt\"]').closest('.call-attachment').textContent.includes('64 KB')"), 'Large text files show a bounded preview with a full download');
  await evaluate("document.querySelector('a[download=\"drawing.svg\"]').closest('.call-attachment').querySelector('.call-attachment-text').open=true");
  await wait("document.querySelector('a[download=\"drawing.svg\"]').closest('.call-attachment').querySelector('pre')");
  assert(await evaluate("!window.__attachmentExecuted && !document.querySelector('.live-reading iframe,.live-reading object,.live-reading embed')"), 'Active file content is displayed as inert text');
  for (const width of [1440, 375]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate("document.querySelector('.call-attachment-thumbnail').click()");
    await wait("document.querySelector('dialog.call-image-dialog[open] img')?.naturalWidth===1");
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.call-image-dialog').getBoundingClientRect().width<=innerWidth"), 'Thumbnail zoom fits ' + width + 'px');
    await evaluate("document.querySelector('.call-image-dialog button').click()");
    await wait("!document.querySelector('.call-image-dialog')");
    assert(await evaluate("document.activeElement.classList.contains('call-attachment-thumbnail')"), 'Closing zoom restores keyboard focus');
  }
  await evaluate("document.querySelector('.live-view-raw').click();document.querySelector('.live-raw-fold').click()");
  assert.equal(await evaluate("document.querySelector('.live-raw-code').textContent"), body, 'Raw request remains byte-for-byte intact');
  await navigate('world');
  assert(await evaluate("window.__attachmentURLs.length>0 && window.__attachmentURLs.every(ref=>window.__attachmentRevoked.includes(ref))"), 'Leaving the inspector releases local object URLs');
  await evaluate("URL.createObjectURL=window.__attachmentCreate;URL.revokeObjectURL=window.__attachmentRevoke;delete window.__attachmentCreate;delete window.__attachmentRevoke;delete window.__attachmentURLs;delete window.__attachmentRevoked");
  return 'request attachments: local thumbnails and zoom, exact file downloads, safe previews, audio controls, nested JSON and URL cleanup';
}
