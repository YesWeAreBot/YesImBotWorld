/** These functions execute inside the page. Keep them self-contained (no host imports). */
export function inspectBrowserDocument(key: string) {
  const w = globalThis as any, d = w.document;
  let registry = w[key];
  if (!registry || registry.document !== d) registry = w[key] = { document: d, id: Math.random().toString(36).slice(2), next: 0, refs: new WeakMap(), nodes: new Map() };
  for (const [ref, node] of registry.nodes) if (!node.isConnected) registry.nodes.delete(ref);
  const clean = (value: unknown, max = 160) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (element: any) => {
    const box = element.getBoundingClientRect(), css = w.getComputedStyle(element);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < w.innerHeight && box.left < w.innerWidth && css.visibility !== "hidden" && css.display !== "none";
  };
  const elements: any[] = [];
  for (const node of d.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]')) {
    if (elements.length >= 90 || !visible(node)) continue;
    let ref = registry.refs.get(node);
    if (!ref) { ref = `e${++registry.next}`; registry.refs.set(node, ref); }
    registry.nodes.set(ref, node);
    const box = node.getBoundingClientRect(), tag = node.tagName.toLowerCase();
    const label = clean(node.getAttribute("aria-label") || node.labels?.[0]?.innerText || node.innerText || node.getAttribute("placeholder") || node.getAttribute("title") || node.getAttribute("alt") || node.name || tag);
    elements.push({ ref, role: node.getAttribute("role") || (node.isContentEditable ? "textbox" : tag), label,
      ...(node.type ? { type: node.type } : {}), ...(tag === "a" ? { href: node.href } : {}),
      ...(node.disabled ? { disabled: true } : {}), ...(node.readOnly ? { readonly: true } : {}),
      ...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
      ...(typeof node.value === "string" && node.type !== "password" ? { value: clean(node.value) } : {}),
      ...(tag === "select" ? { options: [...node.options].slice(0, 30).map((option: any) => ({ value: option.value, label: clean(option.text) })) } : {}),
      x: Math.round(Math.max(0, box.x)), y: Math.round(Math.max(0, box.y)), width: Math.round(box.width), height: Math.round(box.height),
    });
  }
  const links = elements.filter(element => element.href && /^https?:/i.test(element.href)).map(element => ({ url: element.href, text: element.label, ref: element.ref }));
  const images = [...d.images].filter((node: any) => visible(node) && node.naturalWidth > 40 && node.naturalHeight > 40)
    .slice(0, 25).map((node: any) => ({ url: node.currentSrc || node.src, alt: clean(node.alt), width: node.naturalWidth, height: node.naturalHeight }));
  const cover = d.querySelector('meta[property="og:image"]')?.content;
  if (cover) {
    try { const url = new URL(cover, d.baseURI).href; if (!images.some((image: any) => image.url === url)) images.unshift({ url, alt: "页面提供的封面", width: 0, height: 0 }); } catch { /* invalid page metadata */ }
  }
  const videos = [...d.querySelectorAll("video")].slice(0, 8).map((node: any) => ({
    url: node.currentSrc || node.src || "", poster: node.poster || "", paused: node.paused, duration: Number.isFinite(node.duration) ? node.duration : null,
  }));
  return { document: registry.id, url: w.location.href, title: clean(d.title, 250),
    text: String(d.body?.innerText ?? "").trim().slice(0, 12000),
    description: clean(d.querySelector('meta[name="description"],meta[property="og:description"]')?.content, 1000),
    elements, links, images, videos, focusedRef: registry.refs.get(d.activeElement) || null,
    scrollX: Math.round(w.scrollX), scrollY: Math.round(w.scrollY),
    viewport: { width: w.innerWidth, height: w.innerHeight },
  };
}

export function browserElement(key: string, ref: string) {
  const w = globalThis as any;
  const node = w[key]?.nodes.get(ref);
  return node?.isConnected ? node : null;
}

export function browserClickPoint(key: string, ref: string) {
  const w = globalThis as any, node = w[key]?.nodes.get(ref);
  if (!node?.isConnected || node.disabled) return null;
  const rect = node.getBoundingClientRect();
  const x = Math.max(0, Math.min(w.innerWidth, rect.right) + Math.max(0, rect.left)) / 2;
  const y = Math.max(0, Math.min(w.innerHeight, rect.bottom) + Math.max(0, rect.top)) / 2;
  const top = w.document.elementFromPoint(x, y);
  return top && (node === top || node.contains(top)) ? { x, y } : null;
}
