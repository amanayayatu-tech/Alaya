import { useEffect, useState, useSyncExternalStore } from "react";

type NavigateOptions = {
  state?: unknown;
  replace?: boolean;
};

const listeners: Array<() => void> = [];

function emitLocationChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  if (listeners.length === 1) {
    window.addEventListener("hashchange", emitLocationChange);
    window.addEventListener("popstate", emitLocationChange);
  }
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
    if (listeners.length === 0) {
      window.removeEventListener("hashchange", emitLocationChange);
      window.removeEventListener("popstate", emitLocationChange);
    }
  };
}

function normalizeHashTarget(value: string): string {
  const clean = value.replace(/^#?\/?/, "");
  return clean.length > 0 ? `/${clean}` : "/";
}

function currentHashPath(): string {
  if (typeof window === "undefined") return "/";
  const normalized = normalizeHashTarget(window.location.hash);
  return normalized.split("?")[0] || "/";
}

function navigate(to: string, { state = null, replace = false }: NavigateOptions = {}) {
  const oldURL = window.location.href;
  const url = new URL(window.location.href);
  url.hash = normalizeHashTarget(to);
  url.search = "";
  const newURL = url.href;

  if (replace) history.replaceState(state, "", newURL);
  else history.pushState(state, "", newURL);

  const event =
    typeof HashChangeEvent !== "undefined"
      ? new HashChangeEvent("hashchange", { oldURL, newURL })
      : new Event("hashchange");
  window.dispatchEvent(event);
}

function serverPath() {
  return "/";
}

export const useQueryAwareHashLocation = Object.assign(
  ({ ssrPath = "/" }: { ssrPath?: string } = {}) => [
    useSyncExternalStore(subscribe, currentHashPath, () => ssrPath || serverPath()),
    navigate,
  ] as [string, typeof navigate],
  {
    hrefs: (href: string) => `#${href}`,
  },
);

function locationParams(): URLSearchParams {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  if (typeof window === "undefined") return params;

  const hash = window.location.hash.replace(/^#/, "");
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) {
    const hashParams = new URLSearchParams(hash.slice(queryIndex + 1));
    hashParams.forEach((value, key) => {
      if (!params.has(key)) params.set(key, value);
    });
  }
  return params;
}

export function readLocationParam(name: string): string | null {
  return locationParams().get(name);
}

export function useLocationParam(name: string): string | null {
  const [value, setValue] = useState(() => readLocationParam(name));

  useEffect(() => {
    const refresh = () => setValue(readLocationParam(name));
    refresh();
    window.addEventListener("hashchange", refresh);
    window.addEventListener("popstate", refresh);
    return () => {
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("popstate", refresh);
    };
  }, [name]);

  return value;
}
