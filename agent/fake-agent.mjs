#!/usr/bin/env node
// Stands in for the Claude Code side so the whole chain can be tried without it.
//
//   node agent/fake-agent.mjs [--session <id>]
//
// What the phone says shows up here prefixed with "<". Whatever you type is sent
// back to the phone to be read out, exactly as `voice.mjs say` would send it.
// Ctrl+C leaves the session open; type /drop to close it.

import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE_DIR = join(
  process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "voice-chat-for-agents",
);

function newestSession(explicitId) {
  if (explicitId) {
    const file = join(STORE_DIR, `${explicitId}.json`);
    if (!existsSync(file)) throw new Error(`No local record of session ${explicitId}`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const sessions = readdirSync(STORE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(STORE_DIR, name), "utf8")))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (sessions.length === 0) throw new Error("No open session. Run: node agent/voice.mjs start");
  return sessions[0];
}

const explicit = process.argv.includes("--session")
  ? process.argv[process.argv.indexOf("--session") + 1]
  : null;
const session = newestSession(explicit);

const socket = new WebSocket(session.agent_ws_url);
socket.addEventListener("open", () => console.log("connected; type an answer and press Enter"));
socket.addEventListener("close", (event) => {
  console.log(`closed (${event.code})`);
  process.exit(0);
});
socket.addEventListener("message", (event) => console.log(`< ${event.data}`));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();

  if (text === "/drop") {
    await fetch(session.drop_url, {
      method: "POST",
      headers: { authorization: `Bearer ${session.agent_token}` },
    });
    console.log("dropped");
    process.exit(0);
  }

  const response = await fetch(session.say_url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.agent_token}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: Buffer.from(text, "utf8"),
  });
  const body = response.ok ? await response.json() : { delivered: false };
  console.log(body.delivered ? "(spoken)" : "(no phone connected)");
  rl.prompt();
});
