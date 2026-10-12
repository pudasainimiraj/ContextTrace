function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export default {
  async fetch(request, _env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/api/health") {
      return json({ ok: true });
    }

    return json({ error: "not_found", message: "No such route" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
