/// <reference lib="webworker" />
import type { Env } from "../worker-configuration";

function validSid(s: string | null): string | null {
  return s && /^[a-z0-9-]{8,}$/.test(s) ? s : null;
}

export async function getOrCreateSession(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const supplied = validSid(url.searchParams.get("sid"));        // <-- allow client to pin sid
  const cookie = request.headers.get("Cookie") || "";
  const existing = cookie.match(/cf_session=([a-z0-9-]+)/)?.[1];

  const sessionId = supplied ?? existing ?? crypto.randomUUID();
  await env.agent_sessions.put(`sess:${sessionId}`, "1", { expirationTtl: 86_400 });

  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", `cf_session=${sessionId}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly`);

  console.log("[session] issued", { sessionId, supplied: Boolean(supplied), reused: Boolean(existing) });
  return new Response(JSON.stringify({ sessionId }), { headers });
}
