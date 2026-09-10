import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { CLOSE_DROPPED, CLOSE_EXPIRED } from "../src/protocol";
import { ORIGIN, SECRET, createSession, openSocket, pair, pairTokenOf, read, wsUrl, type Session } from "./helpers";

async function newSession(): Promise<Session> {
  const response = await createSession();
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
}

function browserUrl(session: Session): string {
  return `${ORIGIN}/ws/browser?s=${session.session_id}`;
}

async function fireAlarm(sessionId: string): Promise<void> {
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  // alarm() is optional on the base class, but SessionDO always defines it.
  await runInDurableObject(stub, (instance) => instance.alarm!());
}

describe("pairing", () => {
  it("issues a session only with the pre-shared secret", async () => {
    expect((await createSession("wrong")).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/session`, { method: "POST" })).status).toBe(404);
    expect((await createSession()).status).toBe(200);
  });

  it("caps how fast sessions can be opened", async () => {
    // A leaked relay secret buys nothing but bulk session creation, which would
    // spend the daily Durable Object budget. This is the cap on that.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await createSession(SECRET, "203.0.113.7")).status);
    // Cloudflare's limiter is approximate, so the exact cutoff is not the
    // contract: that a burst gets cut off at all is.
    expect(statuses).toContain(429);
    expect(statuses.filter((code) => code === 200).length).toBeLessThan(statuses.length);
  });

  it("redeems the pair token once and sets a per-session cookie", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    expect(cookie.startsWith(`vcs_${session.session_id}=`)).toBe(true);

    const again = await SELF.fetch(`${ORIGIN}/api/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair_token: pairTokenOf(session) }),
    });
    expect(again.status).toBe(404);
  });

  it("refuses an unknown pair token the same way as a used one", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair_token: "AAAAAAAAAAAAAAAAAAAAAA" }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found\n");
  });

  it("expires an unpaired session", async () => {
    const session = await newSession();
    await fireAlarm(session.session_id);

    const response = await SELF.fetch(`${ORIGIN}/api/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pair_token: pairTokenOf(session) }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a browser socket without the cookie", async () => {
    const session = await newSession();
    await pair(session);
    const response = await SELF.fetch(browserUrl(session), { headers: { upgrade: "websocket" } });
    expect(response.status).toBe(404);
  });

  it("rejects an agent socket with a wrong token", async () => {
    const session = await newSession();
    const response = await SELF.fetch(
      `${ORIGIN}/ws/agent?s=${session.session_id}&t=${"x".repeat(43)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(404);
  });
});

describe("relay", () => {
  it("carries an utterance to the agent as one raw line", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const agent = await openSocket(wsUrl(session));
    const agentReader = read(agent);
    const browser = await openSocket(browserUrl(session), { cookie });
    const browserReader = read(browser);

    expect(JSON.parse(await browserReader.next())).toEqual({ type: "ready", agentOnline: true });

    browser.send(JSON.stringify({ type: "utterance", cid: "1", text: "Nézd meg\na tesztet,\r\nkérlek." }));

    // Raw text, no JSON envelope, and folded onto a single line.
    expect(await agentReader.next()).toBe("Nézd meg a tesztet, kérlek.");
    expect(JSON.parse(await browserReader.next())).toEqual({ type: "ack", cid: "1", delivered: true });
  });

  it("carries spoken text to the browser", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const browser = await openSocket(browserUrl(session), { cookie });
    const browserReader = read(browser);
    expect(JSON.parse(await browserReader.next()).type).toBe("ready");

    const response = await SELF.fetch(`${ORIGIN}/api/say?s=${session.session_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
      body: "Kész a teszt. Árvíztűrő tükörfúrógép.",
    });
    expect(await response.json()).toEqual({ delivered: true });
    expect(JSON.parse(await browserReader.next())).toEqual({
      type: "say",
      text: "Kész a teszt. Árvíztűrő tükörfúrógép.",
      seq: 1,
    });
  });

  it("drops an utterance while the agent is away instead of buffering it", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const browser = await openSocket(browserUrl(session), { cookie });
    const browserReader = read(browser);
    expect(JSON.parse(await browserReader.next())).toEqual({ type: "ready", agentOnline: false });

    browser.send(JSON.stringify({ type: "utterance", cid: "1", text: "Ez elveszik." }));
    expect(JSON.parse(await browserReader.next())).toEqual({ type: "ack", cid: "1", delivered: false });

    // The agent arrives afterwards and must not be handed the stale instruction.
    const agent = await openSocket(wsUrl(session));
    const agentReader = read(agent);
    await agentReader.silentFor(150);
    expect(JSON.parse(await browserReader.next())).toEqual({ type: "agent", online: true });
  });

  it("reports an undelivered answer when no phone is listening", async () => {
    const session = await newSession();
    await pair(session);
    const response = await SELF.fetch(`${ORIGIN}/api/say?s=${session.session_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
      body: "Senki nem hallja.",
    });
    expect(await response.json()).toEqual({ delivered: false });
  });

  it("never sends a status message to the agent", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const agent = await openSocket(wsUrl(session));
    const agentReader = read(agent);

    // A phone connecting, sending nothing and leaving must stay invisible here.
    const browser = await openSocket(browserUrl(session), { cookie });
    browser.close();
    await agentReader.silentFor(200);
  });

  it("survives the phone leaving and coming back on the same cookie", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const first = await openSocket(browserUrl(session), { cookie });
    first.close();

    const second = await openSocket(browserUrl(session), { cookie });
    expect(JSON.parse(await read(second).next()).type).toBe("ready");
  });
});

describe("closing", () => {
  it("closes both sockets and refuses everything afterwards", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const agent = await openSocket(wsUrl(session));
    const agentReader = read(agent);
    const browser = await openSocket(browserUrl(session), { cookie });
    const browserReader = read(browser);
    expect(JSON.parse(await browserReader.next()).type).toBe("ready");

    const dropped = await SELF.fetch(`${ORIGIN}/api/drop?s=${session.session_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
    });
    expect(dropped.status).toBe(200);

    expect(JSON.parse(await browserReader.next())).toEqual({ type: "closed", reason: "dropped" });
    expect(await browserReader.closeCode()).toBe(CLOSE_DROPPED);
    expect(await agentReader.closeCode()).toBe(CLOSE_DROPPED);

    const say = await SELF.fetch(`${ORIGIN}/api/say?s=${session.session_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
      body: "Már senki.",
    });
    expect(say.status).toBe(404);

    const reconnect = await SELF.fetch(browserUrl(session), { headers: { upgrade: "websocket", cookie } });
    expect(reconnect.status).toBe(404);
  });

  it("answers the state probe until the session is gone", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const url = `${ORIGIN}/api/state?s=${session.session_id}`;

    const before = await SELF.fetch(url, { headers: { cookie } });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ open: true, agentOnline: false });

    // Without the cookie it is indistinguishable from a session that never was.
    expect((await SELF.fetch(url)).status).toBe(404);

    await SELF.fetch(`${ORIGIN}/api/drop?s=${session.session_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
    });
    expect((await SELF.fetch(url, { headers: { cookie } })).status).toBe(404);
  });

  it("expires a paired session that went idle", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    const browser = await openSocket(browserUrl(session), { cookie });
    const browserReader = read(browser);
    expect(JSON.parse(await browserReader.next()).type).toBe("ready");

    const stub = env.SESSION.get(env.SESSION.idFromName(session.session_id));
    // Pretend the last traffic was long ago, then let the alarm run. The live
    // instance keeps its own copy of the metadata, so both have to move.
    await runInDurableObject(stub, async (instance, state) => {
      const meta = (await state.storage.get<{ lastActivity: number }>("meta"))!;
      meta.lastActivity = Date.now() - 13 * 60 * 60 * 1000;
      await state.storage.put("meta", meta);
      (instance as unknown as { meta: typeof meta }).meta = meta;
    });
    await fireAlarm(session.session_id);

    expect(JSON.parse(await browserReader.next())).toEqual({ type: "closed", reason: "expired" });
    expect(await browserReader.closeCode()).toBe(CLOSE_EXPIRED);
  });

  it("keeps a paired session alive when it is merely quiet", async () => {
    const session = await newSession();
    const cookie = await pair(session);
    await fireAlarm(session.session_id);

    const response = await SELF.fetch(browserUrl(session), { headers: { upgrade: "websocket", cookie } });
    expect(response.status).toBe(101);
  });
});
