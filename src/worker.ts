// Routing, authentication and static files. The Worker holds no state of its own:
// it turns a token into a Durable Object address and gets out of the way.
//
// Every rejection returns the same 404 through the same code path, so a probe
// cannot tell an unknown token from an expired one from a closed session.

import { SessionDO, UNPAIRED_TTL_MS } from "./session-do";
import { looksLikeToken, newAgentToken, newPairToken, sessionIdFromPairToken, sha256 } from "./tokens";

export { SessionDO };

const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "permissions-policy": "microphone=(self), camera=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The single failure response. Identical for every reason a request can fail. */
function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

/** Internal call into the Durable Object. Tokens travel in headers, never in the URL. */
function toObject(
  env: Env,
  sessionId: string,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null },
): Promise<Response> {
  return sessionStub(env, sessionId).fetch(`https://session.internal${path}`, init as RequestInit);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/session" && request.method === "POST") return createSession(request, env, url);
    if (path === "/api/redeem" && request.method === "POST") return redeem(request, env);
    if (path === "/api/say" && request.method === "POST") return say(request, env, url);
    if (path === "/api/drop" && request.method === "POST") return drop(request, env, url);
    if (path === "/ws/browser") return browserSocket(request, env, url);
    if (path === "/ws/agent") return agentSocket(request, env, url);
    if (path === "/api/state") return state(request, env, url);
    // The pair URL is just the app: redeeming happens from the page, so a link
    // preview crawler cannot burn the token before the user taps it. /c/<id> is
    // where the page rewrites itself to once the token has been spent.
    if (path.startsWith("/s/") || path.startsWith("/c/")) return serveApp(request, env, url);
    if (path.startsWith("/api/") || path.startsWith("/ws/")) return notFound();

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;

async function serveApp(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return notFound();
  const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", url), { headers: request.headers }));
  return withSecurityHeaders(asset);
}

async function createSession(request: Request, env: Env, url: URL): Promise<Response> {
  const secret = env.VOICE_RELAY_SECRET;
  const presented = bearer(request);
  if (!secret || !presented || presented !== secret) return notFound();

  const pairToken = newPairToken();
  const agentToken = newAgentToken();
  const sessionId = await sessionIdFromPairToken(pairToken);

  const created = await toObject(env, sessionId, "/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairTokenHash: await sha256(pairToken), agentTokenHash: await sha256(agentToken) }),
  });
  if (!created.ok) return notFound();

  const origin = `${url.protocol}//${url.host}`;
  const wsOrigin = origin.replace(/^http/, "ws");
  return json({
    session_id: sessionId,
    pair_url: `${origin}/s/${pairToken}`,
    agent_token: agentToken,
    agent_ws_url: `${wsOrigin}/ws/agent?s=${sessionId}&t=${agentToken}`,
    say_url: `${origin}/api/say?s=${sessionId}`,
    drop_url: `${origin}/api/drop?s=${sessionId}`,
    expires_in: Math.round(UNPAIRED_TTL_MS / 1000),
  });
}

async function redeem(request: Request, env: Env): Promise<Response> {
  // Stop a guessing attack here, before it can reach a Durable Object and spend
  // the daily request budget.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed = await env.REDEEM_LIMIT?.limit({ key: ip });
  if (allowed && allowed.success === false) {
    return new Response("Too many requests\n", {
      status: 429,
      headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  let pairToken: string | undefined;
  try {
    pairToken = ((await request.json()) as { pair_token?: string }).pair_token;
  } catch {
    return notFound();
  }
  if (!looksLikeToken(pairToken)) return notFound();

  const sessionId = await sessionIdFromPairToken(pairToken);
  const response = await toObject(env, sessionId, "/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairToken }),
  });
  if (!response.ok) return notFound();

  const { cookieToken } = (await response.json()) as { cookieToken: string };
  const result = json({ session_id: sessionId });
  // Named per session so that several conversations can be open in one browser.
  result.headers.append(
    "set-cookie",
    `vcs_${sessionId}=${cookieToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
  );
  return result;
}

async function browserSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return notFound();
  const sessionId = url.searchParams.get("s");
  if (!looksLikeToken(sessionId)) return notFound();
  const cookie = readCookie(request, `vcs_${sessionId}`);
  if (!cookie) return notFound();

  const response = await toObject(env, sessionId, "/ws/browser", {
    headers: { upgrade: "websocket", "x-vc-cookie": cookie },
  });
  return response.webSocket ? new Response(null, { status: 101, webSocket: response.webSocket }) : notFound();
}

async function agentSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return notFound();
  const sessionId = url.searchParams.get("s");
  // The token rides in the query string because no WebSocket client, in a browser
  // or in Node, can set a header on the handshake. Request logging is off.
  const token = url.searchParams.get("t");
  if (!looksLikeToken(sessionId) || !looksLikeToken(token)) return notFound();

  const response = await toObject(env, sessionId, "/ws/agent", {
    headers: { upgrade: "websocket", "x-vc-token": token },
  });
  return response.webSocket ? new Response(null, { status: 101, webSocket: response.webSocket }) : notFound();
}

/**
 * Is this session still open? The page asks once after a failed reconnect, so it
 * can tell "closed" from "no signal" instead of guessing. Never polled.
 */
async function state(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return notFound();
  const sessionId = url.searchParams.get("s");
  if (!looksLikeToken(sessionId)) return notFound();
  const cookie = readCookie(request, `vcs_${sessionId}`);
  if (!cookie) return notFound();

  const response = await toObject(env, sessionId, "/state", { headers: { "x-vc-cookie": cookie } });
  if (!response.ok) return notFound();
  return json(await response.json());
}

async function say(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("s");
  const token = bearer(request);
  if (!looksLikeToken(sessionId) || !looksLikeToken(token)) return notFound();

  const response = await toObject(env, sessionId, "/say", {
    method: "POST",
    headers: { "x-vc-token": token, "content-type": "text/plain; charset=utf-8" },
    body: await request.text(),
  });
  if (!response.ok) return notFound();
  return json(await response.json());
}

async function drop(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("s");
  const token = bearer(request);
  if (!looksLikeToken(sessionId) || !looksLikeToken(token)) return notFound();

  const response = await toObject(env, sessionId, "/drop", { method: "POST", headers: { "x-vc-token": token } });
  if (!response.ok) return notFound();
  return json({ ok: true });
}
