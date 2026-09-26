export function browserPortalHtml(searchURL = "https://www.bing.com/search?q=%s"): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  let search = "";
  try {
    const url = new URL(searchURL);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("unsupported search URL");
    const fields = [...url.searchParams.entries()], query = fields.filter(([, value]) => value === "%s");
    if (query.length === 1 && !url.pathname.includes("%s") && fields.filter(([, value]) => value.includes("%s")).length === 1) {
      search = `<form action="${escape(url.origin + url.pathname)}" method="get">` +
        fields.filter(([name]) => name !== query[0]![0]).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("") +
        `<input name="${escape(query[0]![0])}" aria-label="搜索内容" placeholder="想了解什么？"><button type="submit">搜索</button></form>`;
    } else search = `<p>使用浏览器的 search 操作输入关键词，或<a href="${escape(url.origin + url.pathname)}">打开已配置的搜索入口</a>。</p>`;
  } catch { search = "<p>使用浏览器的 search 操作选择搜索入口。</p>"; }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>浏览器 · 探索</title>
<style>*{box-sizing:border-box}body{margin:0;padding:8vh 7vw;font:18px system-ui;background:#f5f6fa;color:#17213a}main{max-width:760px;margin:auto}svg{width:80px;height:80px}h1{font-size:36px}p{color:#667087;line-height:1.7}form{display:flex;gap:10px;margin:30px 0}input{min-width:0;flex:1;padding:16px;border:1px solid #ccd4e3;border-radius:14px;font:inherit}button,a{padding:16px;border-radius:14px;font:inherit}button{border:0;background:#385ee9;color:white}nav{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}a{background:white;border:1px solid #e1e6f0;text-decoration:none;color:#203353}small{display:block;margin-top:32px;color:#7b8597}</style>
<main><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="30" fill="none" stroke="#385ee9" stroke-width="3"/><ellipse cx="40" cy="40" rx="13" ry="30" fill="none" stroke="#385ee9" stroke-width="2"/><path d="M11 31h58M11 49h58" stroke="#385ee9" stroke-width="2"/><circle cx="61" cy="18" r="7" fill="#eea845"/></svg><h1>打开一个新窗口</h1><p>搜索一个问题，看看视频，或读一条新闻。这里是本地浏览器主页，入口页面的内容以实际加载为准。</p>
${search}
<nav><a href="https://www.bilibili.com/">哔哩哔哩 · 视频</a><a href="https://www.bing.com/">Bing · 搜索</a><a href="https://news.cctv.com/">央视网 · 新闻</a><a href="https://www.wikipedia.org/">维基百科 · 知识</a></nav><small>登录、验证码和访问限制由网站决定；遇到限制可换入口或交由用户处理。</small></main></html>`;
}
