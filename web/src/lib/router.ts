// A history-based router of four routes. No dependency: the application is small and the CSP is strict.
// Routes are matched and built without Vite's base ("/" on the Worker, "/ContextTrace/" on GitHub
// Pages); the base is added when a URL goes to the browser and removed when one comes back.

import { useEffect, useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type Route =
  | { page: "home" }
  | { page: "repository"; owner: string; name: string }
  | { page: "status" }
  | { page: "about" }
  | { page: "notFound" };

export type Location = { pathname: string; search: string };

const REPOSITORY_RE = /^\/r\/([^/]+)\/([^/]+)\/?$/;

export function matchRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { page: "home" };
  if (pathname === "/status") return { page: "status" };
  if (pathname === "/about") return { page: "about" };
  const m = REPOSITORY_RE.exec(pathname);
  if (m) {
    try {
      return { page: "repository", owner: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]) };
    } catch {
      return { page: "notFound" };
    }
  }
  return { page: "notFound" };
}

/** The path of a repository page, with an optional query. */
export function repositoryPath(fullName: string, query?: string): string {
  const [owner, name] = fullName.split("/");
  const base = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return query ? `${base}?q=${encodeURIComponent(query)}` : base;
}

/** The browser URL of an application path. */
export function href(to: string): string {
  return BASE + to;
}

const listeners = new Set<() => void>();

function current(): Location {
  const { pathname, search } = window.location;
  const path = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return { pathname: path || "/", search };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", href(to));
  else window.history.pushState(null, "", href(to));
  for (const listener of listeners) listener();
}

/** The location, updated on navigate() and on the browser's Back and Forward. */
export function useLocation(): Location {
  const [location, setLocation] = useState<Location>(current);
  useEffect(() => {
    const update = () => setLocation(current());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return location;
}
