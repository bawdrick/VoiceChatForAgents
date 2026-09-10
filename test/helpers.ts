import { SELF } from "cloudflare:test";

export const SECRET = "test-secret";
export const ORIGIN = "https://relay.test";

export type Session = {
  session_id: string;
  pair_url: string;
  agent_token: string;
  agent_ws_url: string;
};

export async function createSession(secret = SECRET): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

export function pairTokenOf(session: Session): string {
  return session.pair_url.split("/s/")[1]!;
}

/** Runs the pairing the phone would do on first load and returns the cookie header. */
export async function pair(session: Session): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pair_token: pairTokenOf(session) }),
  });
  if (response.status !== 200) throw new Error(`redeem failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

export async function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const response = await SELF.fetch(url, { headers: { upgrade: "websocket", ...headers } });
  if (response.status !== 101 || !response.webSocket) throw new Error(`upgrade failed: ${response.status}`);
  const ws = response.webSocket;
  ws.accept();
  return ws;
}

export type SocketReader = {
  next(timeoutMs?: number): Promise<string>;
  silentFor(ms: number): Promise<void>;
  closeCode(timeoutMs?: number): Promise<number>;
};

/** Turns socket events into something a test can await. */
export function read(ws: WebSocket): SocketReader {
  const messages: string[] = [];
  const waiting: Array<(value: string) => void> = [];
  let closed: number | null = null;
  const closeWaiting: Array<(value: number) => void> = [];

  ws.addEventListener("message", (event: MessageEvent) => {
    const text = typeof event.data === "string" ? event.data : "";
    const next = waiting.shift();
    if (next) next(text);
    else messages.push(text);
  });
  ws.addEventListener("close", (event: CloseEvent) => {
    closed = event.code;
    while (closeWaiting.length) closeWaiting.shift()!(event.code);
  });

  return {
    next(timeoutMs = 2000) {
      const queued = messages.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message arrived")), timeoutMs);
        waiting.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    silentFor(ms: number) {
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => (messages.length === 0 ? resolve() : reject(new Error(`received: ${messages[0]}`))), ms);
      });
    },
    closeCode(timeoutMs = 2000) {
      if (closed !== null) return Promise.resolve(closed);
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket stayed open")), timeoutMs);
        closeWaiting.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };
}

export function wsUrl(session: Session): string {
  return session.agent_ws_url.replace(/^ws/, "http");
}
