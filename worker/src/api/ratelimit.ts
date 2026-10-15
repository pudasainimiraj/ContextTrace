/**
 * Per-address request limits with the Workers rate-limiting binding. The key is the address
 * Cloudflare puts in cf-connecting-ip on every request that reaches the Worker; local
 * development and tests have no such header and are not limited. The binding is per
 * location and eventually consistent: it blunts bursts, while the budgets stay the hard caps.
 */
export type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export const RATE_LIMIT_RETRY_SECONDS = 60;

export function clientKey(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

/** A 429 when the caller is over the limiter's window; null when the request may proceed. */
export async function rateLimitResponse(limiter: Limiter | undefined, request: Request, route: string): Promise<Response | null> {
  const key = clientKey(request);
  if (!limiter || key === null) return null;
  const { success } = await limiter.limit({ key: `${route}:${key}` });
  if (success) return null;
  return Response.json(
    { error: "rate_limited", message: "Too many requests from this address; try again in a minute" },
    { status: 429, headers: { "Retry-After": String(RATE_LIMIT_RETRY_SECONDS) } },
  );
}
