import { ProxyAgent } from "undici";

const proxyAgents = new Map<string, ProxyAgent>();

export interface FetchWithProxyOptions extends RequestInit {
  /** 显式代理 URL；为空时回退到 HTTPS_PROXY / HTTP_PROXY 环境变量 */
  proxy?: string;
}

export function fetchWithProxy(url: string, options: FetchWithProxyOptions = {}): Promise<Response> {
  const { proxy, ...init } = options;
  const resolved = resolveProxy(proxy);
  if (!resolved) return fetch(url, init);
  return fetch(url, { ...init, dispatcher: getProxyAgent(resolved) } as unknown as RequestInit);
}

function resolveProxy(configured?: string): string {
  const value =
    configured?.trim() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  return value?.trim() || "";
}

function getProxyAgent(proxy: string): ProxyAgent {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}
