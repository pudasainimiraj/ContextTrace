// API errors in the user's words. The API message stays available as details.

import type { ApiError } from "../../../shared/api.ts";

export type ErrorAction = "none" | "list" | "status" | "reload" | "retry" | "about" | "home";
export type ErrorView = { copy: string; action: ErrorAction; retryAfterSeconds: number | null; details: string | null };
export type ErrorContext = "register" | "search" | "read";

/** A failed response (status 0 for no connection) as copy, a next action and the raw message. */
export function describeApiError(status: number, body: ApiError | null, retryAfter: string | null, context: ErrorContext): ErrorView {
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const wait = seconds === null ? "shortly" : seconds >= 120 ? `in ${Math.round(seconds / 60)} minutes` : `in ${seconds} seconds`;
  const view = (copy: string, action: ErrorAction = "none"): ErrorView => ({ copy, action, retryAfterSeconds: seconds, details: body && body.message !== copy ? body.message : null });

  if (status === 0) return view("No connection. Check the network and try again.", "retry");
  switch (body?.error) {
    case "invalid_input":
    case "unsupported_media_type":
    case "payload_too_large":
      return view(body.message);
    case "repository_not_found":
      return view("GitHub has no public repository at this address. Check the spelling. Private repositories cannot be indexed.");
    case "repository_not_public":
      return view("Only public repositories can be indexed.", "about");
    case "admissions_paused":
      return view(`${body.message.replace(/\.?$/, ".")} ${body.message.startsWith("Storage") ? "" : "You can search any repository in the list."}`.trim(), body.message.startsWith("Storage") ? "status" : "list");
    case "budget_exhausted":
      return view(context === "search" ? "Today's search allowance for this service is used up. It resets at 00:00 UTC." : "Today's allowance for new repositories is used up. It resets at 00:00 UTC.", "status");
    case "rate_limited":
      if (status === 429) {
        return view(context === "search" ? "Thirty searches a minute per address. Wait a moment." : context === "register" ? "Five registrations a minute per address. Wait a moment." : "Too many requests from this address. Wait a moment.", "retry");
      }
      return view(`GitHub is rate-limiting the service. Try again ${wait}.`, "retry");
    case "service_paused":
      return view(`The service's hourly GitHub allowance is used up. Try again ${wait}.`, "retry");
    case "verification_failed":
      return view("The bot check did not pass. Reload the page and try again.", "reload");
    case "verification_unavailable":
      return view("The bot check service did not answer. Try again in 30 seconds.", "retry");
    case "not_found":
      return view(context === "search" ? "This repository is not indexed. Add it from the home page." : "Not found.", "home");
    case "upstream_error":
      return view("GitHub had a problem answering. It has been logged. Try again in a minute.", "retry");
  }
  if (status >= 500) return view("The service had a problem. It has been logged. Try again in a minute.", "retry");
  return view(body?.message ?? `Request failed (${status})`);
}

/** Parses an error body, tolerating one that is not JSON. */
export async function readError(res: Response): Promise<ApiError | null> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    return typeof body.error === "string" && typeof body.message === "string" ? (body as ApiError) : null;
  } catch {
    return null;
  }
}
