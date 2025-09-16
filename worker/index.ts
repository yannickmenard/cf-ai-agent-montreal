/// <reference types="@cloudflare/workers-types" />

import type { Env } from "../worker-configuration";
import { routeAgentRequest } from "agents";
import { getOrCreateSession } from "./session";
export { default as AIAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);

    // 0) Hand off any /agents/... traffic (WS + HTTP) to the Agents SDK router.
    const routed = await (routeAgentRequest as unknown as (req: Request, env: Env) => Promise<Response | null>)(request, env);
    if (routed) return routed;

    // 1) Session cookie endpoint: ensures cf_session is set for this origin (dev + prod).
    if (url.pathname === "/api/session" && request.method === "GET") {
      return (await getOrCreateSession(request, env)) as unknown as Response;
    }

    // 2) File streaming: /files/:sid/:name → stream from R2 (PUBLIC)
    if (url.pathname.startsWith("/files/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["files", ":sid", ":name..."]
      if (parts.length >= 3) {
        const sid = parts[1]!;
        const name = decodeURIComponent(parts.slice(2).join("/"));
        const key = `files/${sid}/${name}`;

        const obj = await env.agent_browser_uploads.get(key);
        if (!obj) return new Response("Not found", { status: 404 });

        const headers = new Headers();
        if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
        headers.set("content-disposition", `inline; filename="${name.replace(/"/g, "")}"`);
        headers.set("cache-control", "private, max-age=0, must-revalidate");

        return new Response(obj.body as unknown as globalThis.ReadableStream, { headers });
      }
      return new Response("Bad Request", { status: 400 });
    }

    // /api/files/:sid/:name → stream from R2 (PUBLIC)
    if (url.pathname.startsWith("/api/files/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api", "files", ":sid", ":name..."]
      if (parts.length >= 4) {
        const sid = parts[2]!;
        const name = decodeURIComponent(parts.slice(3).join("/"));
        const key = `files/${sid}/${name}`;

        const obj = await env.agent_browser_uploads.get(key);
        if (!obj) return new Response("Not found", { status: 404 });

        const headers = new Headers();
        if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
        headers.set("content-disposition", `inline; filename="${name.replace(/"/g, "")}"`);
        headers.set("cache-control", "public, max-age=3600");
        headers.set("x-worker", "on");
        headers.set("x-route", "api-files");

        return new Response(obj.body as unknown as globalThis.ReadableStream, { headers });
      }
      return new Response("Bad Request", { status: 400 });
    }



    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "x-worker": "on" },
      });
    }

    // 3) Fall through to static assets (SPA)
    // IMPORTANT: do NOT detach this method; call it on the binding.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
