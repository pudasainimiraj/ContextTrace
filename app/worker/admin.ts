/** Admin-only endpoints need `Authorization: Bearer <ADMIN_TOKEN>`; without the secret configured they are closed. */
export async function requireAdmin(request: Request, adminToken: string | undefined): Promise<Response | null> {
  if (!adminToken) {
    return Response.json({ error: "admin_disabled", message: "Admin endpoints are disabled: ADMIN_TOKEN is not set" }, { status: 503 });
  }
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) {
    return Response.json({ error: "unauthorized", message: "An admin token is required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  if (!secretsEqual(match[1], adminToken)) {
    return Response.json({ error: "forbidden", message: "The admin token is not valid" }, { status: 403 });
  }
  return null;
}

/** Constant-time comparison: the time taken does not depend on where the strings differ. */
export function secretsEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.byteLength ^ y.byteLength;
  for (let i = 0; i < Math.max(x.byteLength, y.byteLength); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
