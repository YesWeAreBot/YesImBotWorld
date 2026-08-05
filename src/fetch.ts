import { fetch as undiciFetch, ProxyAgent } from "undici";
import { describeError } from "./llm/http.js";

const proxyAgents = new Map<string, ProxyAgent>();

export interface FetchWithProxyOptions extends RequestInit {
  /** 显式代理 URL；为空时回退到 HTTPS_PROXY / HTTP_PROXY 环境变量 */
  proxy?: string;
}

export async function fetchWithProxy(url: string, options: FetchWithProxyOptions = {}): Promise<Response> {
  const { proxy, ...init } = options;
  const resolved = resolveProxy(proxy);
  try {
    // 走代理时必须用 undici 自己的 fetch：把 npm undici 的 ProxyAgent 传给
    // Node 内置 fetch（内置的是另一个版本的 undici）属于跨实例混用，不受支持，
    // 症状正是笼统的 "TypeError: fetch failed"
    if (!resolved) return await fetch(url, init);
    return (await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher: getProxyAgent(resolved),
    })) as unknown as Response;
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
    throw new Error(`请求失败（${url.slice(0, 120)}）: ${describeError(err)}`, { cause: err });
  }
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
