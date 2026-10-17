/**
 * Cross-origin access for the SPA served from GitHub Pages. ALLOWED_ORIGINS (wrangler.jsonc,
 * comma-separated) names the browser origins that may call the API; any other origin, and every
 * request without an Origin header, gets no CORS headers at all. The headers the client reads
 * (Retry-After, Location) are exposed explicitly.
 */

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization";
const EXPOSE_HEADERS = "Retry-After, Location";
const MAX_AGE_SECONDS = 86_400;

/** The request's Origin when it is allowed, else null. */
export function allowedOrigin(request: Request, allowedOrigins: string | undefined): string | null {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins) return null;
  return allowedOrigins.split(",").some((allowed) => allowed.trim() === origin) ? origin : null;
}

/** The answer to a preflight from an allowed origin: no body, the permissions, cached for a day. */
export function preflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": ALLOW_METHODS,
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Max-Age": String(MAX_AGE_SECONDS),
      Vary: "Origin",
    },
  });
}

/** Adds the CORS headers for an allowed origin to a response; a null origin leaves it untouched. */
export function withCors(response: Response, origin: string | null): Response {
  if (origin === null) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  response.headers.append("Vary", "Origin");
  return response;
}
