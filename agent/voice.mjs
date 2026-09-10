#!/usr/bin/env node
// Machine side of the voice channel.
//
//   node agent/voice.mjs start            open a session, print the QR code
//   node agent/voice.mjs listen           stream what the phone says, one line each
//   node agent/voice.mjs say "..."        read something out on the phone
//   node agent/voice.mjs drop             close the session
//   node agent/voice.mjs status           list the sessions this machine opened
//
// The listen command is the one with a contract: every line it writes on stdout
// becomes one conversation event in the Claude Code session. Nothing else may
// ever appear there, so all diagnostics go to stderr.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(
  process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "voice-chat-for-agents",
);
const KEEPALIVE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_GONE = 3;
const EXIT_CONFIG = 4;

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------- config

function loadConfig() {
  const file = join(HERE, "voice.config.json");
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      fail(`agent/voice.config.json is not valid JSON: ${error.message}`, EXIT_CONFIG);
    }
  }
  const url = (process.env.VOICE_RELAY_URL || fromFile.url || "").replace(/\/+$/, "");
  const secret = process.env.VOICE_RELAY_SECRET || fromFile.secret || "";
  if (!url || !secret) {
    fail(
      "Missing relay URL or secret.\n" +
        "Copy agent/voice.config.example.json to agent/voice.config.json and fill it in,\n" +
        "or set VOICE_RELAY_URL and VOICE_RELAY_SECRET.",
      EXIT_CONFIG,
    );
  }
  return { url, secret };
}

// ------------------------------------------------------------ session store

function ensureStore() {
  // Created up front and checked here, so a missing directory fails now with a
  // readable message instead of inside an error handler later.
  mkdirSync(STORE_DIR, { recursive: true });
  return STORE_DIR;
}

function sessionFile(id) {
  return join(ensureStore(), `${id}.json`);
}

function saveSession(session) {
  writeFileSync(sessionFile(session.session_id), JSON.stringify(session, null, 2), "utf8");
}

function listSessions() {
  ensureStore();
  return readdirSync(STORE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(STORE_DIR, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function resolveSession(explicitId) {
  if (explicitId) {
    const file = sessionFile(explicitId);
    if (!existsSync(file)) fail(`No local record of session ${explicitId}.`, EXIT_GONE);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const sessions = listSessions();
  if (sessions.length === 0) fail("No open session. Run: node agent/voice.mjs start", EXIT_GONE);
  if (sessions.length > 1) {
    process.stderr.write(`Several sessions are open; using the newest (${sessions[0].session_id}).\n`);
  }
  return sessions[0];
}

function forgetSession(id) {
  try {
    rmSync(sessionFile(id));
  } catch {
    /* already gone */
  }
}

// -------------------------------------------------------------------- start

async function cmdStart() {
  const { url, secret } = loadConfig();
  let response;
  try {
    response = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch (error) {
    fail(`Cannot reach the relay at ${url}: ${error.message}`, EXIT_CONFIG);
  }
  if (!response.ok) {
    fail(`The relay refused to open a session (HTTP ${response.status}). Check the secret.`, EXIT_CONFIG);
  }

  const session = await response.json();
  session.created_at = Date.now();
  session.relay_url = url;
  saveSession(session);

  const script = resolve(HERE, "voice.mjs");
  const errFile = join(STORE_DIR, `${session.session_id.slice(0, 8)}.err`);

  await printQr(session.pair_url);
  const image = await writeQrImage(session.pair_url, session.session_id);
  const out = [
    "",
    `Pair URL (single use, valid for ${Math.round(session.expires_in / 60)} minutes):`,
    `  ${session.pair_url}`,
    "",
    ...(image ? ["QR code as an image (block characters do not survive every viewer):", `  ${image}`, ""] : []),
    "Monitor this command in the Claude Code session:",
    `  node "${script}" listen --session ${session.session_id} 2>>"${errFile}"`,
    "",
    "Speak an answer (whole reply in one call, stdin keeps accents intact):",
    `  node "${script}" say --session ${session.session_id} "Kész van."`,
    "",
    "Close the channel:",
    `  node "${script}" drop --session ${session.session_id}`,
    "",
  ].join("\n");
  process.stdout.write(out);
}

/**
 * The same code as a PNG. Half block characters need an exact line height to
 * scan, which a chat window or a copied terminal will not give you.
 */
async function writeQrImage(text, sessionId) {
  const file = join(ensureStore(), `${sessionId.slice(0, 8)}.png`);
  try {
    const { default: qrcode } = await import("qrcode");
    await qrcode.toFile(file, text, { width: 640, margin: 2, errorCorrectionLevel: "M" });
    return file;
  } catch (error) {
    process.stderr.write(`could not write the QR image: ${error.message}
`);
    return null;
  }
}

async function printQr(text) {
  try {
    const { default: qrcode } = await import("qrcode-terminal");
    await new Promise((done) => qrcode.generate(text, { small: true }, (art) => {
      process.stdout.write(`${art}\n`);
      done();
    }));
  } catch {
    process.stderr.write("qrcode-terminal is not installed; showing the URL only.\n");
  }
}

// ------------------------------------------------------------------- listen

function cmdListen(args) {
  const session = resolveSession(args.session);
  let attempt = 0;
  let stopping = false;

  const stop = (code) => {
    stopping = true;
    process.exit(code);
  };
  process.on("SIGINT", () => stop(EXIT_OK));
  process.on("SIGTERM", () => stop(EXIT_OK));

  const open = () => {
    if (stopping) return;
    let socket;
    try {
      socket = new WebSocket(session.agent_ws_url);
    } catch (error) {
      process.stderr.write(`connect failed: ${error.message}\n`);
      return retry();
    }

    let keepalive = null;

    socket.addEventListener("open", () => {
      attempt = 0;
      process.stderr.write(`connected ${new Date().toISOString()}\n`);
      // Not a protocol ping, because a WebSocket client in Node cannot send one.
      // The relay ignores whatever arrives here; the point is that writing to a
      // dead connection eventually surfaces as an error instead of silence.
      keepalive = setInterval(() => {
        try {
          socket.send("keepalive");
        } catch {
          /* the close handler deals with it */
        }
      }, KEEPALIVE_MS);
    });

    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      // The contract: one frame, one line, nothing added.
      process.stdout.write(`${text.replace(/[\r\n]+/g, " ")}\n`);
    });

    socket.addEventListener("error", () => {
      /* the close event carries the outcome */
    });

    socket.addEventListener("close", (event) => {
      clearInterval(keepalive);
      if (stopping) return;
      // Application close codes mean the session is over. Retrying would be a
      // polling loop against a relay that will keep saying no.
      if (event.code >= 4000 && event.code <= 4003) {
        process.stderr.write(`session closed by the relay (${event.code})\n`);
        forgetSession(session.session_id);
        process.exit(EXIT_OK);
      }
      process.stderr.write(`disconnected (${event.code})\n`);
      retry();
    });
  };

  const retry = () => {
    attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
    process.stderr.write(`reconnecting in ${Math.round(delay)} ms\n`);
    setTimeout(open, delay);
  };

  open();
}

// ---------------------------------------------------------------- say / drop

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdSay(args) {
  const session = resolveSession(args.session);
  // Text from the command line, or from stdin when there is none. Passing it on
  // stdin is the safe route on Windows, where argv conversion can mangle
  // non-ASCII characters.
  const text = args.rest.length > 0 ? args.rest.join(" ") : await readStdin();
  if (!text.trim()) fail("Nothing to say.", EXIT_USAGE);

  const response = await fetch(session.say_url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.agent_token}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: Buffer.from(text, "utf8"),
  });
  if (response.status === 404) {
    forgetSession(session.session_id);
    fail("The session is closed.", EXIT_GONE);
  }
  if (!response.ok) fail(`Relay error: HTTP ${response.status}`, EXIT_GONE);

  const body = await response.json();
  process.stdout.write(body.delivered ? "spoken\n" : "no phone connected, nothing was read out\n");
}

async function cmdDrop(args) {
  const session = resolveSession(args.session);
  const response = await fetch(session.drop_url, {
    method: "POST",
    headers: { authorization: `Bearer ${session.agent_token}` },
  });
  forgetSession(session.session_id);
  process.stdout.write(response.ok ? "session closed\n" : "session was already gone\n");
}

function cmdStatus() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stdout.write("no open session\n");
    return;
  }
  for (const session of sessions) {
    const age = Math.round((Date.now() - (session.created_at || 0)) / 60000);
    process.stdout.write(`${session.session_id}  opened ${age} min ago  ${session.relay_url}\n`);
  }
}

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { session: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session" || argv[i] === "-s") args.session = argv[++i];
    else args.rest.push(argv[i]);
  }
  return args;
}

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);

switch (command) {
  case "start":
    await cmdStart();
    break;
  case "listen":
    cmdListen(args);
    break;
  case "say":
    await cmdSay(args);
    break;
  case "drop":
    await cmdDrop(args);
    break;
  case "status":
    cmdStatus();
    break;
  default:
    fail("Usage: node agent/voice.mjs start|listen|say|drop|status [--session <id>]");
}
