import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("GET /api/health responds ok", async () => {
  const res = await exports.default.fetch("http://localhost/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("unknown /api route responds 404 JSON", async () => {
  const res = await exports.default.fetch("http://localhost/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: "not_found" });
});
