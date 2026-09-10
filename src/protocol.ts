// Wire formats. Two of them, deliberately different.
//
// Browser <-> Durable Object: JSON, because the browser needs to tell a spoken
// answer apart from a status change.
//
// Durable Object -> agent: raw UTF-8 text and nothing else, ever. The agent-side
// client writes every frame it receives as one line on stdout, and every such line
// becomes a conversation event in the Claude Code session. A status message there
// would read as something the user said.

/** Keepalive. Answered by setWebSocketAutoResponse without waking the object. */
export const PING = "ping";
export const PONG = "pong";

export const MAX_UTTERANCE_CHARS = 4000;

/** Application close codes. The agent client decides whether to retry from these. */
export const CLOSE_DROPPED = 4000; // the session was closed on purpose
export const CLOSE_EXPIRED = 4001; // idle or never paired
export const CLOSE_REPLACED = 4002; // another browser took over this session
export const CLOSE_UNAUTHORIZED = 4003; // token or cookie rejected

export type BrowserToRelay = {
  type: "utterance";
  /** Client-side id, echoed back in the ack so the bubble can be marked. */
  cid: string;
  text: string;
};

export type RelayToBrowser =
  | { type: "ready"; agentOnline: boolean }
  | { type: "ack"; cid: string; delivered: boolean }
  | { type: "agent"; online: boolean }
  | { type: "say"; text: string; seq: number }
  | { type: "closed"; reason: "dropped" | "expired" };
