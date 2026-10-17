// One way to call the API: a typed value on success, the user's words on failure.

import { describeApiError, readError, type ErrorContext, type ErrorView } from "./errors.ts";

// Where the API lives: empty on the Worker, which serves both; the Worker's URL on GitHub Pages.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export type ApiResult<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: ErrorView };

export async function api<T>(path: string, context: ErrorContext, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    return { ok: false, status: 0, error: describeApiError(0, null, null, context) };
  }
  if (!res.ok) {
    const body = await readError(res);
    return { ok: false, status: res.status, error: describeApiError(res.status, body, res.headers.get("Retry-After"), context) };
  }
  try {
    return { ok: true, status: res.status, value: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, error: describeApiError(res.status, null, null, context) };
  }
}

export function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
