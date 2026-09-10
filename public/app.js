// The phone side. Speech in, speech out, one text channel in between.
//
// Most of what looks over-careful here is not: it is the shape the Web Speech API
// forces on you, especially on Android. The comments say which is which.

(() => {
  "use strict";

  const STORE = {
    lang: "vc-lang",
    speak: "vc-speak",
    autoSend: "vc-autosend",
    rate: "vc-rate",
    voice: "vc-voice",
    subs: "vc-subs",
    diag: "vc-diag",
    continuous: "vc-continuous",
  };

  const DEFAULTS = { lang: "hu-HU", speak: "on", autoSend: 3000, rate: 1 };
  const PING_INTERVAL_MS = 45_000;
  const PONG_TIMEOUT_MS = 10_000;
  const MAX_BACKOFF_MS = 30_000;
  // Chrome finalises a phrase well after the audio stops, so the microphone stays
  // deaf a little longer than the synthesiser is busy.
  const ECHO_TAIL_MS = 3000;
  // A turn that ends without a spoken answer is invisible to the relay, and the
  // phone would wait for it forever. After this the page gives up waiting.
  const WAITING_TIMEOUT_MS = 180_000;
  const SPEECH_CHUNK_CHARS = 180;

  const el = (id) => document.getElementById(id);
  const dom = {
    status: el("status"),
    statusText: el("statusText"),
    banner: el("banner"),
    log: el("log"),
    empty: el("empty"),
    form: el("composeForm"),
    input: el("input"),
    sendBtn: el("sendBtn"),
    micBtn: el("micBtn"),
    speakerBtn: el("speakerBtn"),
    settingsBtn: el("settingsBtn"),
    settings: el("settings"),
    closeSettings: el("closeSettings"),
    langSelect: el("langSelect"),
    autoSendSelect: el("autoSendSelect"),
    rateInput: el("rateInput"),
    rateOut: el("rateOut"),
    voiceSelect: el("voiceSelect"),
    subsInput: el("subsInput"),
    diagToggle: el("diagToggle"),
    testTtsBtn: el("testTtsBtn"),
    countdown: el("countdown"),
    countdownText: el("countdownText"),
    cancelSend: el("cancelSend"),
  };

  // ---------------------------------------------------------------- settings

  function readStore(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private mode */
    }
  }

  // A phone has no usable console, so the switches that matter are reachable from
  // the address bar and then remembered.
  const query = new URLSearchParams(location.search);
  for (const [param, key] of [
    ["lang", STORE.lang],
    ["speak", STORE.speak],
    ["diag", STORE.diag],
  ]) {
    const value = query.get(param);
    if (value) writeStore(key, value);
  }

  const settings = {
    lang: readStore(STORE.lang, DEFAULTS.lang),
    speak: readStore(STORE.speak, DEFAULTS.speak) !== "off",
    autoSend: Number(readStore(STORE.autoSend, DEFAULTS.autoSend)),
    rate: Number(readStore(STORE.rate, DEFAULTS.rate)),
    voice: readStore(STORE.voice, ""),
    subs: readStore(STORE.subs, ""),
    diag: readStore(STORE.diag, "off") === "on",
  };

  // ------------------------------------------------------------- diagnostics

  const diagBox = el("diag");

  function diag(message) {
    if (!settings.diag) return;
    diagBox.hidden = false;
    const time = new Date().toLocaleTimeString();
    diagBox.textContent = `${time}  ${message}\n${diagBox.textContent}`.slice(0, 8000);
  }

  diagBox.addEventListener("click", () => {
    diagBox.textContent = "";
  });

  // -------------------------------------------------------------- app state

  const app = {
    sessionId: null,
    socket: null,
    connected: false,
    agentOnline: false,
    closed: false,
    closedReason: "",
    attempt: 0,
    reconnectTimer: null,
    pingTimer: null,
    pongTimer: null,
    micWanted: false,
    listening: false,
    committed: "", // the text confirmed so far, without the live interim tail
    interim: "",
    autoSendTimer: null,
    autoSendTick: null,
    autoSendAt: 0,
    waiting: false, // an utterance went out and nothing has been read back yet
    waitingTimer: null,
    speaking: false,
    suppressRecognition: false,
    suppressTimer: null,
    wakeLock: null,
    cid: 0,
    pending: new Map(),
  };

  const STATUS = {
    connecting: ["connecting", "Kapcsolódás…"],
    idle: ["idle", "Kész"],
    listening: ["listening", "Hallgatlak"],
    recognizing: ["recognizing", "Felismerés…"],
    armed: ["armed", "Küldés…"],
    waiting: ["waiting", "Várom a választ"],
    speaking: ["speaking", "Felolvasás"],
    offline: ["offline", "Nincs kapcsolat"],
    closed: ["closed", "Lezárult"],
    error: ["error", "Hiba"],
  };

  function render() {
    let key = "idle";
    if (app.closed) key = "closed";
    else if (!app.connected) key = app.attempt === 0 ? "connecting" : "offline";
    else if (app.speaking) key = "speaking";
    else if (app.autoSendTimer) key = "armed";
    else if (app.interim) key = "recognizing";
    else if (app.waiting) key = "waiting";
    else if (app.listening) key = "listening";

    const [cls, text] = STATUS[key];
    dom.status.className = `status state-${cls}`;
    let suffix = "";
    if (key === "closed" && app.closedReason) suffix = ` (${app.closedReason})`;
    else if (app.connected && !app.agentOnline && !app.closed) suffix = " · gép nincs itt";
    dom.statusText.textContent = text + suffix;

    dom.micBtn.setAttribute("aria-pressed", String(app.micWanted));
    dom.speakerBtn.setAttribute("aria-pressed", String(settings.speak));
    dom.sendBtn.disabled = app.closed || dom.input.value.trim() === "";
  }

  function showBanner(message) {
    dom.banner.textContent = message;
    dom.banner.hidden = false;
  }

  // ------------------------------------------------------------ conversation

  function addMessage(kind, text) {
    dom.empty.hidden = true;
    const node = document.createElement("div");
    node.className = `msg ${kind === "mine" ? "mine" : "theirs"}`;
    const body = document.createElement("div");
    body.textContent = text;
    node.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "msg-foot";
    const stamp = document.createElement("span");
    stamp.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    foot.appendChild(stamp);

    if (kind === "theirs") {
      // Automatic reading happens once. If the phone was in a pocket, or the
      // speech queue jammed, this button is the only way back to it.
      const replay = document.createElement("button");
      replay.type = "button";
      replay.className = "replay";
      replay.title = "Felolvasás újra";
      replay.textContent = "🔊";
      replay.addEventListener("click", () => speak(text, { force: true }));
      foot.appendChild(replay);
    }

    node.appendChild(foot);
    dom.log.appendChild(node);
    dom.log.scrollTop = dom.log.scrollHeight;
    return { node, foot };
  }

  function markFailed(entry, text) {
    entry.node.classList.add("failed");
    const note = document.createElement("span");
    note.textContent = "nem ért oda";
    entry.foot.appendChild(note);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "link";
    retry.textContent = "vissza a mezőbe";
    retry.addEventListener("click", () => {
      setComposed(text);
      dom.input.focus();
    });
    entry.foot.appendChild(retry);
  }

  // --------------------------------------------------------------- speaking

  let voices = [];
  let spokenOnce = false;
  const speechQueue = [];

  function loadVoices() {
    voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    dom.voiceSelect.textContent = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "automatikus";
    dom.voiceSelect.appendChild(auto);
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} [${voice.lang}]`;
      dom.voiceSelect.appendChild(option);
    }
    dom.voiceSelect.value = settings.voice;
    checkVoiceAvailability();
  }

  function pickVoice() {
    const base = settings.lang.split("-")[0].toLowerCase();
    return (
      voices.find((v) => v.name === settings.voice) ||
      voices.find((v) => v.lang && v.lang.replace("_", "-") === settings.lang) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(base)) ||
      null
    );
  }

  function checkVoiceAvailability() {
    if (!window.speechSynthesis) {
      showBanner("Ez a böngésző nem tud felolvasni. A szöveg így is látszik a képernyőn.");
      return false;
    }
    if (voices.length === 0) {
      // The list arrives late on some devices, so this is not a refusal: the
      // utterance still carries the language and the platform picks what it has.
      if (spokenOnce) showBanner("Nem látok telepített hangot. A rendszer alapértelmezett hangját használom.");
      return true;
    }
    if (!pickVoice()) {
      showBanner(
        `Nincs telepítve ${settings.lang} hang ezen az eszközön, ezért nem olvasok fel. ` +
          "Android: Beállítások → Nyelvek → Szövegfelolvasás → nyelv letöltése.",
      );
      return false;
    }
    dom.banner.hidden = true;
    return true;
  }

  /** The synthesiser stalls on long input, so it is fed in sentence-sized pieces. */
  function chunk(text) {
    const sentences = text.split(/(?<=[.!?…])\s+/);
    const out = [];
    for (const sentence of sentences) {
      if (sentence.length <= SPEECH_CHUNK_CHARS) {
        if (sentence.trim()) out.push(sentence.trim());
        continue;
      }
      let rest = sentence;
      while (rest.length > SPEECH_CHUNK_CHARS) {
        let cut = rest.lastIndexOf(" ", SPEECH_CHUNK_CHARS);
        if (cut < SPEECH_CHUNK_CHARS / 2) cut = SPEECH_CHUNK_CHARS;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      if (rest.trim()) out.push(rest.trim());
    }
    return out;
  }

  function speak(text, options = {}) {
    if (!window.speechSynthesis) return;
    // The replay button is an explicit intent, so it ignores the device mute.
    if (!options.force && !settings.speak) return;
    if (!checkVoiceAvailability()) return;

    // Cancelling first also clears a queue that jammed, which Chrome does often
    // enough to matter.
    spokenOnce = true;
    window.speechSynthesis.cancel();
    speechQueue.length = 0;
    speechQueue.push(...chunk(text));
    app.speaking = true;
    suppress();
    render();
    playNext();
  }

  function playNext() {
    const piece = speechQueue.shift();
    if (piece === undefined) {
      app.speaking = false;
      releaseSuppression();
      render();
      // Anything said while the answer was being read out is still in the box.
      if (dom.input.value.trim()) armAutoSend();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(piece);
    utterance.lang = settings.lang;
    utterance.rate = settings.rate;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = playNext;
    utterance.onerror = (event) => {
      diag(`TTS hiba: ${event.error}`);
      playNext();
    };
    window.speechSynthesis.speak(utterance);
  }

  function suppress() {
    app.suppressRecognition = true;
    clearTimeout(app.suppressTimer);
  }

  /**
   * Release only once the synthesiser is genuinely idle. Answers arrive as one
   * block but are spoken in pieces, and an 'end' in the middle of the queue used
   * to reopen the microphone while we were still talking.
   */
  function releaseSuppression() {
    clearTimeout(app.suppressTimer);
    const idle = () =>
      !window.speechSynthesis || (!window.speechSynthesis.speaking && !window.speechSynthesis.pending);
    const tryRelease = () => {
      if (!idle()) {
        app.suppressTimer = setTimeout(tryRelease, 250);
        return;
      }
      app.suppressTimer = setTimeout(() => {
        if (!idle()) return tryRelease();
        app.suppressRecognition = false;
        diag("mikrofon újra éles");
      }, ECHO_TAIL_MS);
    };
    tryRelease();
  }

  // -------------------------------------------------------------- composing

  function setComposed(text) {
    app.committed = text;
    app.interim = "";
    dom.input.value = text;
    dom.input.classList.remove("interim");
    autoGrow();
    render();
  }

  function paintComposed() {
    const joined = app.interim ? `${app.committed} ${app.interim}`.trim() : app.committed;
    dom.input.value = joined;
    dom.input.classList.toggle("interim", Boolean(app.interim));
    autoGrow();
  }

  function autoGrow() {
    dom.input.style.height = "auto";
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  function commitInterim() {
    if (!app.interim) return;
    app.committed = `${app.committed} ${app.interim}`.trim();
    app.interim = "";
    paintComposed();
  }

  function parseSubs(text) {
    const rules = [];
    for (const line of text.split("\n")) {
      const index = line.indexOf("=");
      if (index === -1) continue;
      const from = line.slice(0, index).trim();
      const to = line.slice(index + 1).trim();
      if (from) rules.push({ from, to });
    }
    return rules;
  }

  /** The recogniser cannot be primed with a vocabulary, so fix its output here. */
  function applySubs(text) {
    let out = text;
    for (const { from, to } of parseSubs(settings.subs)) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), to);
      } catch {
        out = out.split(from).join(to);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- auto send

  function armAutoSend() {
    cancelAutoSend();
    if (settings.autoSend <= 0) return;
    // Never fire into a turn that is already running: that is exactly the
    // interruption the whole one-utterance-at-a-time design avoids.
    if (app.waiting || app.speaking || app.closed) return;
    if (!dom.input.value.trim()) return;

    app.autoSendAt = Date.now() + settings.autoSend;
    dom.countdown.hidden = false;
    const tick = () => {
      const left = Math.max(0, app.autoSendAt - Date.now());
      dom.countdownText.textContent = `Küldés ${(left / 1000).toFixed(1)} mp múlva`;
    };
    tick();
    app.autoSendTick = setInterval(tick, 100);
    app.autoSendTimer = setTimeout(() => {
      cancelAutoSend();
      send();
    }, settings.autoSend);
    render();
  }

  function cancelAutoSend() {
    clearTimeout(app.autoSendTimer);
    clearInterval(app.autoSendTick);
    app.autoSendTimer = null;
    app.autoSendTick = null;
    dom.countdown.hidden = true;
    render();
  }

  // ----------------------------------------------------------------- sending

  function send() {
    cancelAutoSend();
    commitInterim();
    const text = applySubs(dom.input.value).replace(/\s+/g, " ").trim();
    if (!text) return;

    const entry = addMessage("mine", text);
    setComposed("");

    if (!app.socket || app.socket.readyState !== WebSocket.OPEN) {
      markFailed(entry, text);
      return;
    }
    const cid = String(++app.cid);
    app.pending.set(cid, { entry, text });
    app.socket.send(JSON.stringify({ type: "utterance", cid, text }));
    startWaiting();
  }

  function startWaiting() {
    clearTimeout(app.waitingTimer);
    app.waiting = true;
    app.waitingTimer = setTimeout(() => stopWaiting(), WAITING_TIMEOUT_MS);
    render();
  }

  function stopWaiting() {
    clearTimeout(app.waitingTimer);
    app.waitingTimer = null;
    app.waiting = false;
    render();
    if (dom.input.value.trim()) armAutoSend();
  }

  // ------------------------------------------------------------- connection

  function wsUrl() {
    const base = location.origin.replace(/^http/, "ws");
    return `${base}/ws/browser?s=${encodeURIComponent(app.sessionId)}`;
  }

  function connect() {
    if (app.closed) return;
    clearTimeout(app.reconnectTimer);
    let socket;
    try {
      socket = new WebSocket(wsUrl());
    } catch (error) {
      diag(`socket hiba: ${error}`);
      scheduleReconnect();
      return;
    }
    app.socket = socket;

    socket.addEventListener("open", () => {
      app.connected = true;
      app.attempt = 0;
      diag("WS nyitva");
      startPing();
      render();
    });

    socket.addEventListener("message", (event) => {
      if (event.data === "pong") {
        clearTimeout(app.pongTimer);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(message);
    });

    socket.addEventListener("close", (event) => {
      app.connected = false;
      stopPing();
      diag(`WS zárva: ${event.code}`);
      if (event.code === 4000 || event.code === 4001) {
        markClosed(event.code === 4000 ? "lezárva a gépen" : "lejárt");
        return;
      }
      if (event.code === 4002) {
        markClosed("egy másik eszköz vette át");
        return;
      }
      scheduleReconnect();
      render();
    });

    socket.addEventListener("error", () => diag("WS hiba"));
  }

  function handle(message) {
    switch (message.type) {
      case "ready":
        app.agentOnline = Boolean(message.agentOnline);
        break;
      case "agent":
        app.agentOnline = Boolean(message.online);
        break;
      case "ack": {
        const pending = app.pending.get(message.cid);
        app.pending.delete(message.cid);
        if (pending && !message.delivered) {
          markFailed(pending.entry, pending.text);
          stopWaiting();
        }
        break;
      }
      case "say":
        stopWaiting();
        addMessage("theirs", message.text);
        speak(message.text);
        break;
      case "closed":
        markClosed(message.reason === "dropped" ? "lezárva a gépen" : "lejárt");
        break;
      default:
        break;
    }
    render();
  }

  function markClosed(reason) {
    app.closed = true;
    app.closedReason = reason;
    app.connected = false;
    stopPing();
    stopRecognition();
    app.micWanted = false;
    releaseWakeLock();
    cancelAutoSend();
    render();
  }

  function scheduleReconnect() {
    if (app.closed) return;
    app.attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (app.attempt - 1)) * (0.7 + Math.random() * 0.6);
    diag(`újracsatlakozás ${Math.round(delay)} ms múlva (${app.attempt}.)`);
    app.reconnectTimer = setTimeout(connect, delay);
    // A refused upgrade and a dead network look identical from here, so after a
    // couple of failures ask once, on purpose, rather than guessing forever.
    if (app.attempt === 2) probeState();
    render();
  }

  async function probeState() {
    try {
      const response = await fetch(`/api/state?s=${encodeURIComponent(app.sessionId)}`, {
        headers: { accept: "application/json" },
      });
      if (response.status === 404) markClosed("nincs ilyen beszélgetés");
    } catch {
      /* offline; the backoff keeps trying */
    }
  }

  function startPing() {
    stopPing();
    app.pingTimer = setInterval(() => {
      if (!app.socket || app.socket.readyState !== WebSocket.OPEN) return;
      app.socket.send("ping");
      clearTimeout(app.pongTimer);
      app.pongTimer = setTimeout(() => {
        diag("nincs pong, újracsatlakozás");
        try {
          app.socket.close();
        } catch {
          /* already closing */
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    clearInterval(app.pingTimer);
    clearTimeout(app.pongTimer);
    app.pingTimer = null;
  }

  // ------------------------------------------------------------ recognition

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;

  function buildRecognition() {
    if (!SpeechRecognition) return null;
    const instance = new SpeechRecognition();
    const stored = readStore(STORE.continuous, null);
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // Android Chrome starts, hears speech in continuous mode and never fires
    // onresult. Single phrase mode plus the restart in onend keeps dictation
    // running anyway.
    instance.continuous = stored === null ? !isMobile : stored === "true";
    instance.interimResults = true;
    instance.lang = settings.lang;
    diag(`felismerő: lang=${instance.lang} continuous=${instance.continuous}`);

    instance.onstart = () => {
      app.listening = true;
      render();
    };
    instance.onspeechstart = () => {
      // Still talking, so the pause has not happened yet.
      cancelAutoSend();
      diag("beszéd észlelve");
    };
    instance.onnomatch = () => diag("nomatch");

    instance.onresult = (event) => {
      // Our own voice must never come back in as if the user had said it. The
      // live synthesiser state is checked too, not just the flag, so a bug in the
      // release timer cannot open the door.
      if (
        app.suppressRecognition ||
        (window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending))
      ) {
        diag("eredmény eldobva (mi beszélünk)");
        return;
      }

      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Take the final transcript itself: the last interim is shorter and
        // rougher, and using it clips the end of every sentence.
        if (result.isFinal) {
          app.committed = `${app.committed} ${result[0].transcript.trim()}`.trim();
        } else {
          interim += result[0].transcript;
        }
      }
      app.interim = interim.trim();
      paintComposed();
      if (!app.interim) armAutoSend();
      render();
    };

    instance.onerror = (event) => {
      diag(`felismerő hiba: ${event.error}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        app.micWanted = false;
        showBanner("A mikrofon engedélye hiányzik. Engedélyezd a böngészőben, majd kapcsold be újra.");
      }
    };

    instance.onend = () => {
      app.listening = false;
      // A phrase can end without ever producing a final result, which used to
      // leave the interim text stuck in the box forever.
      commitInterim();
      if (dom.input.value.trim()) armAutoSend();
      if (app.micWanted && !app.closed) {
        try {
          instance.start();
        } catch (error) {
          diag(`újraindítás nem sikerült: ${error}`);
        }
      }
      render();
    };

    return instance;
  }

  function startRecognition() {
    if (!recognition) recognition = buildRecognition();
    if (!recognition) return;
    try {
      recognition.start();
    } catch {
      /* already running */
    }
  }

  function stopRecognition() {
    app.listening = false;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* not running */
    }
  }

  async function requestWakeLock() {
    // Without this the screen locks, Chrome suspends the tab, and microphone and
    // speech die together.
    if (!("wakeLock" in navigator)) return;
    try {
      app.wakeLock = await navigator.wakeLock.request("screen");
      diag("wake lock megvan");
    } catch (error) {
      diag(`wake lock nem sikerült: ${error}`);
    }
  }

  function releaseWakeLock() {
    if (!app.wakeLock) return;
    app.wakeLock.release().catch(() => {});
    app.wakeLock = null;
  }

  function setMic(wanted) {
    app.micWanted = wanted;
    if (wanted) {
      startRecognition();
      requestWakeLock();
    } else {
      stopRecognition();
      releaseWakeLock();
      cancelAutoSend();
    }
    render();
  }

  // ------------------------------------------------------------------ events

  dom.form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  dom.input.addEventListener("input", () => {
    // Manual editing wins over whatever the recogniser thought.
    app.committed = dom.input.value;
    app.interim = "";
    dom.input.classList.remove("interim");
    autoGrow();
    cancelAutoSend();
    render();
  });

  dom.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  dom.cancelSend.addEventListener("click", cancelAutoSend);
  dom.micBtn.addEventListener("click", () => setMic(!app.micWanted));
  dom.speakerBtn.addEventListener("click", () => {
    settings.speak = !settings.speak;
    writeStore(STORE.speak, settings.speak ? "on" : "off");
    if (!settings.speak && window.speechSynthesis) window.speechSynthesis.cancel();
    render();
  });

  dom.settingsBtn.addEventListener("click", () => {
    dom.settings.hidden = !dom.settings.hidden;
    dom.settingsBtn.setAttribute("aria-expanded", String(!dom.settings.hidden));
  });
  dom.closeSettings.addEventListener("click", () => {
    dom.settings.hidden = true;
    dom.settingsBtn.setAttribute("aria-expanded", "false");
  });

  dom.langSelect.addEventListener("change", () => {
    settings.lang = dom.langSelect.value;
    writeStore(STORE.lang, settings.lang);
    // One place decides the language for both directions, so they cannot drift.
    if (recognition) {
      stopRecognition();
      recognition = null;
    }
    if (app.micWanted) startRecognition();
    checkVoiceAvailability();
  });

  dom.autoSendSelect.addEventListener("change", () => {
    settings.autoSend = Number(dom.autoSendSelect.value);
    writeStore(STORE.autoSend, settings.autoSend);
    cancelAutoSend();
  });

  dom.rateInput.addEventListener("input", () => {
    settings.rate = Number(dom.rateInput.value);
    dom.rateOut.textContent = settings.rate.toFixed(1).replace(".", ",");
    writeStore(STORE.rate, settings.rate);
  });

  dom.voiceSelect.addEventListener("change", () => {
    settings.voice = dom.voiceSelect.value;
    writeStore(STORE.voice, settings.voice);
    checkVoiceAvailability();
  });

  dom.subsInput.addEventListener("change", () => {
    settings.subs = dom.subsInput.value;
    writeStore(STORE.subs, settings.subs);
  });

  dom.diagToggle.addEventListener("change", () => {
    settings.diag = dom.diagToggle.checked;
    writeStore(STORE.diag, settings.diag ? "on" : "off");
    diagBox.hidden = !settings.diag;
  });

  dom.testTtsBtn.addEventListener("click", () =>
    speak("Árvíztűrő tükörfúrógép. A felolvasás működik.", { force: true }),
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Coming back from another app: the recogniser is dead even though the button
    // still looks on, and the socket may have been cut while we were away.
    if (app.micWanted && !app.listening) startRecognition();
    if (app.micWanted) requestWakeLock();
    if (!app.connected && !app.closed) {
      app.attempt = 0;
      connect();
    }
  });

  window.addEventListener("online", () => {
    if (!app.connected && !app.closed) {
      app.attempt = 0;
      connect();
    }
  });

  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }

  // --------------------------------------------------------------- bootstrap

  function fillSettingsUi() {
    dom.langSelect.value = settings.lang;
    if (dom.langSelect.value !== settings.lang) {
      const option = document.createElement("option");
      option.value = settings.lang;
      option.textContent = settings.lang;
      dom.langSelect.appendChild(option);
      dom.langSelect.value = settings.lang;
    }
    dom.autoSendSelect.value = String(settings.autoSend);
    if (!dom.autoSendSelect.value) dom.autoSendSelect.value = String(DEFAULTS.autoSend);
    dom.rateInput.value = String(settings.rate);
    dom.rateOut.textContent = settings.rate.toFixed(1).replace(".", ",");
    dom.subsInput.value = settings.subs;
    dom.diagToggle.checked = settings.diag;
    diagBox.hidden = !settings.diag;
  }

  async function boot() {
    fillSettingsUi();
    loadVoices();
    render();

    if (!SpeechRecognition) {
      showBanner("Ez a böngésző nem ismer beszédet. Androidon Chrome kell hozzá. Gépelve így is használható.");
      dom.micBtn.disabled = true;
    }

    const path = location.pathname;
    if (path.startsWith("/s/")) {
      const pairToken = decodeURIComponent(path.slice(3));
      try {
        const response = await fetch("/api/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pair_token: pairToken }),
        });
        if (!response.ok) {
          markClosed(response.status === 429 ? "túl sok próbálkozás" : "a párosító link már nem él");
          return;
        }
        const body = await response.json();
        app.sessionId = body.session_id;
      } catch {
        markClosed("nem sikerült párosítani");
        return;
      }
      // Get the token out of the address bar and out of the history.
      history.replaceState(null, "", `/c/${app.sessionId}${location.search}`);
    } else if (path.startsWith("/c/")) {
      app.sessionId = decodeURIComponent(path.slice(3));
    } else {
      markClosed("nincs nyitott beszélgetés");
      dom.empty.textContent = "Nincs nyitott beszélgetés. Olvasd be a QR kódot a gépen.";
      dom.empty.hidden = false;
      return;
    }

    connect();
  }

  boot();
})();
