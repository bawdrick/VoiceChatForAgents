// One Durable Object instance is one conversation. It holds the pairing state and
// wires the phone WebSocket to the agent WebSocket. It never stores anything that
// was said.
//
// Cost model, non-negotiable:
//   - state.acceptWebSocket() only, never ws.accept(): the latter bills wall clock
//     time for the entire life of the connection.
//   - keepalive through setWebSocketAutoResponse(), which is answered without
//     waking the object.
//   - no setTimeout or setInterval anywhere; they would keep the object resident.
//     Anything time based is a storage alarm.

import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_DROPPED,
  CLOSE_EXPIRED,
  CLOSE_REPLACED,
  PING,
  PONG,
  type BrowserToRelay,
  type RelayToBrowser,
} from "./protocol";
import { normalizeSpeech, normalizeUtterance } from "./text";
import { newCookieToken, sha256, timingSafeEqual } from "./tokens";

// Long enough to get the phone out, open the camera and let the page load,
// which two minutes was not. The token is still single use and 128 bits wide.
export const UNPAIRED_TTL_MS = 10 * 60 * 1000;
export const IDLE_TTL_MS = 12 * 60 * 60 * 1000;

const TAG_BROWSER = "browser";
const TAG_AGENT = "agent";

type Meta = {
  createdAt: number;
  pairTokenHash: string;
  agentTokenHash: string;
  cookieHash: string | null;
  pairedAt: number | null;
  lastActivity: number;
  seq: number;
};

const notFound = () => new Response(null, { status: 404 });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export class SessionDO extends DurableObject<Env> {
  private meta: Meta | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime while the object stays hibernated. Only the browser
    // uses this. The agent side must never receive a frame it did not ask for,
    // because every frame it receives becomes a line of conversation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get<Meta>("meta")) ?? null;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/create":
        return this.handleCreate(request);
      case "/redeem":
        return this.handleRedeem(request);
      case "/ws/browser":
        return this.handleBrowserSocket(request);
      case "/ws/agent":
        return this.handleAgentSocket(request);
      case "/state":
        return this.handleState(request);
      case "/say":
        return this.handleSay(request);
      case "/drop":
        return this.handleDrop(request);
      default:
        return notFound();
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    if (this.meta) return notFound(); // a session id is never reused
    const body = (await request.json()) as { pairTokenHash: string; agentTokenHash: string };
    const now = Date.now();
    this.meta = {
      createdAt: now,
      pairTokenHash: body.pairTokenHash,
      agentTokenHash: body.agentTokenHash,
      cookieHash: null,
      pairedAt: null,
      lastActivity: now,
      seq: 0,
    };
    await this.ctx.storage.put("meta", this.meta);
    await this.ctx.storage.setAlarm(now + UNPAIRED_TTL_MS);
    return json({ ok: true });
  }

  // The pair token is single use: the phone trades it for a session cookie, so a
  // reload or a rotated screen does not need the QR code again.
  private async handleRedeem(request: Request): Promise<Response> {
    const meta = this.meta;
    if (!meta || meta.pairedAt !== null) return notFound();
    const body = (await request.json()) as { pairToken?: string };
    if (!timingSafeEqual(await sha256(body.pairToken ?? ""), meta.pairTokenHash)) return notFound();
    if (Date.now() - meta.createdAt > UNPAIRED_TTL_MS) {
      await this.destroy("expired");
      return notFound();
    }

    const cookieToken = newCookieToken();
    meta.cookieHash = await sha256(cookieToken);
    meta.pairedAt = Date.now();
    meta.lastActivity = meta.pairedAt;
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.lastActivity + IDLE_TTL_MS);
    return json({ cookieToken });
  }

  private async handleBrowserSocket(request: Request): Promise<Response> {
    const meta = this.meta;
    const presented = request.headers.get("x-vc-cookie") ?? "";
    if (!meta || !meta.cookieHash) return notFound();
    if (!timingSafeEqual(await sha256(presented), meta.cookieHash)) return notFound();

    // One phone at a time. A second tab takes over rather than doubling the audio.
    for (const existing of this.ctx.getWebSockets(TAG_BROWSER)) {
      try {
        existing.close(CLOSE_REPLACED, "replaced");
      } catch {
        /* already gone */
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [TAG_BROWSER]);
    await this.touch();
    this.sendToBrowser(pair[1], { type: "ready", agentOnline: this.agentSocket() !== null });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async handleAgentSocket(request: Request): Promise<Response> {
    const meta = this.meta;
    const presented = request.headers.get("x-vc-token") ?? "";
    if (!meta) return notFound();
    if (!timingSafeEqual(await sha256(presented), meta.agentTokenHash)) return notFound();

    for (const existing of this.ctx.getWebSockets(TAG_AGENT)) {
      try {
        existing.close(CLOSE_REPLACED, "replaced");
      } catch {
        /* already gone */
      }
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [TAG_AGENT]);
    await this.touch();
    // Nothing is sent on this socket here, and nothing ever will be except the
    // words the user spoke.
    this.broadcastToBrowser({ type: "agent", online: true });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Answers one question, on demand: is this conversation still open? The page
  // asks after a failed reconnect so it can say something true to the user.
  private async handleState(request: Request): Promise<Response> {
    const meta = this.meta;
    const presented = request.headers.get("x-vc-cookie") ?? "";
    if (!meta || !meta.cookieHash) return notFound();
    if (!timingSafeEqual(await sha256(presented), meta.cookieHash)) return notFound();
    return json({ open: true, agentOnline: this.agentSocket() !== null });
  }

  private async handleSay(request: Request): Promise<Response> {
    const meta = this.meta;
    const presented = request.headers.get("x-vc-token") ?? "";
    if (!meta) return notFound();
    if (!timingSafeEqual(await sha256(presented), meta.agentTokenHash)) return notFound();

    const text = normalizeSpeech(await request.text());
    if (!text) return json({ delivered: false, reason: "empty" });

    meta.seq += 1;
    const delivered = this.broadcastToBrowser({ type: "say", text, seq: meta.seq });
    await this.touch();
    // Nothing is buffered for a phone that is not listening: by the time it comes
    // back, an answer to a question it no longer remembers asking is noise.
    return json({ delivered });
  }

  private async handleDrop(request: Request): Promise<Response> {
    const meta = this.meta;
    const presented = request.headers.get("x-vc-token") ?? "";
    if (!meta) return notFound();
    if (!timingSafeEqual(await sha256(presented), meta.agentTokenHash)) return notFound();
    await this.destroy("dropped");
    return json({ ok: true });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    // The agent socket is download only. Whatever arrives on it is a keepalive at
    // best, and answering would put a line into the conversation.
    if (tags.includes(TAG_AGENT)) return;
    if (!this.meta || typeof message !== "string") return;

    let parsed: BrowserToRelay;
    try {
      parsed = JSON.parse(message) as BrowserToRelay;
    } catch {
      return;
    }
    if (parsed?.type !== "utterance") return;

    const text = normalizeUtterance(parsed.text ?? "");
    const agent = this.agentSocket();
    if (!text || !agent) {
      // Not buffered on purpose: delivering a stale instruction on reconnect is
      // worse than losing it.
      this.sendToBrowser(ws, { type: "ack", cid: parsed.cid, delivered: false });
      return;
    }

    try {
      // Raw UTF-8, no envelope: this frame becomes one line on the agent stdout.
      agent.send(text);
      this.sendToBrowser(ws, { type: "ack", cid: parsed.cid, delivered: true });
    } catch {
      this.sendToBrowser(ws, { type: "ack", cid: parsed.cid, delivered: false });
    }
    await this.touch();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getTags(ws).includes(TAG_AGENT)) {
      // Tell the phone, never the agent: the agent learns about state only from
      // its own connection closing.
      this.broadcastToBrowser({ type: "agent", online: this.agentSocket(ws) !== null });
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    const meta = this.meta;
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (meta.pairedAt === null) {
      await this.destroy("expired");
      return;
    }
    if (Date.now() - meta.lastActivity >= IDLE_TTL_MS) {
      await this.destroy("expired");
      return;
    }
    // Rearm from the last real traffic instead of rewriting the alarm on every
    // message.
    await this.ctx.storage.setAlarm(meta.lastActivity + IDLE_TTL_MS);
  }

  private async destroy(reason: "dropped" | "expired"): Promise<void> {
    const code = reason === "dropped" ? CLOSE_DROPPED : CLOSE_EXPIRED;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(ws).includes(TAG_BROWSER)) {
        this.sendToBrowser(ws, { type: "closed", reason });
      }
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
    this.meta = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private async touch(): Promise<void> {
    if (!this.meta) return;
    this.meta.lastActivity = Date.now();
    await this.ctx.storage.put("meta", this.meta);
  }

  /** The live agent socket, ignoring one that is in the middle of closing. */
  private agentSocket(exclude?: WebSocket): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(TAG_AGENT)) {
      if (ws === exclude) continue;
      if (ws.readyState === WebSocket.READY_STATE_OPEN) return ws;
    }
    return null;
  }

  private sendToBrowser(ws: WebSocket, message: RelayToBrowser): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* the phone went away mid send */
    }
  }

  private broadcastToBrowser(message: RelayToBrowser): boolean {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets(TAG_BROWSER)) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      this.sendToBrowser(ws, message);
      delivered = true;
    }
    return delivered;
  }
}
