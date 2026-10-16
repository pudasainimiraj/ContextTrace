// A history-based router of four routes. No dependency: the application is small and the CSP is strict.

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

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

const listeners = new Set<() => void>();

function current(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
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

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** An in-app link: a plain left click navigates without a reload; modified clicks and new tabs work as usual. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
