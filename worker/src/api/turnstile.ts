/**
 * Server-side Turnstile verification. A token is single-use and lives five minutes; the
 * secret never leaves the server. Verification is enforced only when TURNSTILE_SECRET_KEY
 * is set, and fails closed when the verification service cannot be reached.
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const MAX_TURNSTILE_TOKEN_CHARS = 2048;

export type TurnstileResult = { success: boolean; errorCodes: string[] };

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
  fetchImpl: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): Promise<TurnstileResult> {
  const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: unknown; "error-codes"?: unknown };
  const codes = Array.isArray(body["error-codes"]) ? body["error-codes"].map(String) : [];
  if (!res.ok && codes.length === 0) codes.push(`http-${res.status}`);
  return { success: body.success === true, errorCodes: codes };
}
