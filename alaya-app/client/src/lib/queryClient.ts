import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const API_KEY_STORAGE_KEY = "alaya.apiKey";
const API_KEY_EVENT = "alaya-api-key-changed";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

export function getApiKey(): string {
  return storage()?.getItem(API_KEY_STORAGE_KEY)?.trim() ?? "";
}

export function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

export function setApiKey(value: string) {
  const trimmed = value.trim();
  const target = storage();
  if (!target) return;
  if (trimmed) target.setItem(API_KEY_STORAGE_KEY, trimmed);
  else target.removeItem(API_KEY_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(API_KEY_EVENT));
}

export function onApiKeyChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(API_KEY_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(API_KEY_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function withApiHeaders(headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  const key = getApiKey();
  if (key) out.set("Authorization", `Bearer ${key}`);
  return out;
}

export function apiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE}${url}`;
}

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(url), {
    ...init,
    headers: withApiHeaders(init.headers),
  });
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers = new Headers(data ? { "Content-Type": "application/json" } : undefined);
  const res = await apiFetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await apiFetch(queryKey.join("/"));

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
