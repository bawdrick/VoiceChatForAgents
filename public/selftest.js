// Proves or disproves the speech layer on the device it runs on. Everything it
// reports is measured here and now; nothing is assumed.

(() => {
  "use strict";

  const LANG = new URLSearchParams(location.search).get("lang") || "hu-HU";
  const PHRASE = "Árvíztűrő tükörfúrógép. A felolvasás működik.";

  const logBox = document.getElementById("log");
  const lines = [];

  function log(message) {
    lines.push(`${new Date().toLocaleTimeString()}  ${message}`);
    logBox.textContent = lines.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
  }

  function row(table, label, verdict, detail) {
    const existing = table.querySelector(`[data-label="${label}"]`);
    const tr = existing || document.createElement("tr");
    tr.dataset.label = label;
    tr.textContent = "";
    const name = document.createElement("td");
    name.textContent = label;
    const value = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = `tag ${verdict}`;
    tag.textContent = { pass: "rendben", fail: "bukás", warn: "figyelj", wait: "várakozik" }[verdict];
    value.appendChild(tag);
    if (detail) {
      const text = document.createElement("div");
      text.textContent = detail;
      value.appendChild(text);
    }
    tr.appendChild(name);
    tr.appendChild(value);
    if (!existing) table.appendChild(tr);
    log(`${label}: ${verdict}${detail ? ` — ${detail}` : ""}`);
  }

  const failures = new Set();

  function verdict(label, level) {
    if (level === "fail") failures.add(label);
    else failures.delete(label);
    const dot = document.getElementById("verdictDot").parentElement;
    const text = document.getElementById("verdict");
    if (failures.size > 0) {
      dot.className = "status state-fail";
      text.textContent = `Bukás: ${[...failures].join(", ")}`;
    } else {
      dot.className = "status state-pass";
      text.textContent = "Eddig minden rendben";
    }
  }

  // -------------------------------------------------------- what is available

  const capabilities = document.getElementById("capabilities");
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  row(capabilities, "Böngésző", "pass", navigator.userAgent);
  row(capabilities, "Biztonságos környezet", window.isSecureContext ? "pass" : "fail",
    window.isSecureContext ? location.origin : "nem biztonságos eredet: a mikrofon nem engedhető meg");
  if (!window.isSecureContext) verdict("biztonságos környezet", "fail");

  row(capabilities, "SpeechRecognition", Recognition ? "pass" : "fail",
    Recognition ? (window.SpeechRecognition ? "SpeechRecognition" : "webkitSpeechRecognition") :
      "nincs — ebben a böngészőben nem lehet diktálni");
  if (!Recognition) verdict("felismerés", "fail");

  row(capabilities, "speechSynthesis", window.speechSynthesis ? "pass" : "fail",
    window.speechSynthesis ? "megvan" : "nincs — nem lesz felolvasás");
  if (!window.speechSynthesis) verdict("felolvasás", "fail");

  row(capabilities, "Wake Lock", "wakeLock" in navigator ? "pass" : "warn",
    "wakeLock" in navigator ? "megvan, a képernyő ébren tartható" :
      "nincs — zárolt képernyőn a lap felfügged, és a mikrofon elhal");

  row(capabilities, "Felismerés nyelve", "pass", LANG + "  (?lang= paraméterrel más)");

  function reportVoices() {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    const base = LANG.split("-")[0].toLowerCase();
    const matching = voices.filter((v) => v.lang && v.lang.replace("_", "-").toLowerCase().startsWith(base));
    if (voices.length === 0) {
      row(capabilities, "Telepített hangok", "warn", "a lista üres — lehet, hogy késve érkezik");
      return;
    }
    row(capabilities, "Telepített hangok", "pass", `${voices.length} db`);
    if (matching.length === 0) {
      row(capabilities, `${LANG} hang`, "fail",
        `nincs. Van viszont: ${voices.slice(0, 6).map((v) => v.lang).join(", ")}…  ` +
          "Android: Beállítások → Nyelvek → Szövegfelolvasás → nyelv letöltése");
      verdict("nincs magyar hang", "fail");
    } else {
      row(capabilities, `${LANG} hang`, "pass", matching.map((v) => `${v.name} [${v.lang}]`).join(", "));
      verdict("nincs magyar hang", "pass");
    }
  }

  reportVoices();
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      log("voiceschanged");
      reportVoices();
    });
  }

  // ------------------------------------------------------------------ speaking

  const ttsResults = document.getElementById("ttsResults");
  document.getElementById("ttsBtn").addEventListener("click", () => {
    if (!window.speechSynthesis) return;
    row(ttsResults, "Felolvasás", "wait", "elindítva…");
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(PHRASE);
    utterance.lang = LANG;
    const voices = window.speechSynthesis.getVoices();
    const base = LANG.split("-")[0].toLowerCase();
    const voice =
      voices.find((v) => v.lang && v.lang.replace("_", "-") === LANG) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(base));
    if (voice) utterance.voice = voice;
    row(ttsResults, "Használt hang", voice ? "pass" : "warn",
      voice ? `${voice.name} [${voice.lang}]` : "nincs illeszkedő hang, a rendszer alapértelmezettje szól");

    const started = Date.now();
    utterance.onstart = () => row(ttsResults, "Felolvasás", "wait", "szól…");
    utterance.onend = () => {
      const ms = Date.now() - started;
      // A synthesiser that reports success in a few milliseconds did not speak.
      const real = ms > 700;
      row(ttsResults, "Felolvasás", real ? "pass" : "fail",
        real ? `${ms} ms alatt végzett` : `${ms} ms alatt "végzett" — ennyi idő alatt nem szólalt meg`);
      verdict("felolvasás", real ? "pass" : "fail");
      row(ttsResults, "Hallottad magyarul?", "warn", "ezt csak te tudod eldönteni — ez a lap nem hallja");
    };
    utterance.onerror = (event) => {
      row(ttsResults, "Felolvasás", "fail", `hiba: ${event.error}`);
      verdict("felolvasás", "fail");
    };
    window.speechSynthesis.speak(utterance);
  });

  // --------------------------------------------------------------- recognising

  const sttResults = document.getElementById("sttResults");
  const heard = document.getElementById("heard");
  const sttBtn = document.getElementById("sttBtn");

  let recognition = null;
  let wanted = false;
  let finals = 0;
  let sawAudio = false;
  let restartFailures = 0;

  sttBtn.addEventListener("click", () => {
    if (!Recognition) return;
    wanted = !wanted;
    sttBtn.setAttribute("aria-pressed", String(wanted));
    sttBtn.textContent = wanted ? "Leállítás" : "Felismerés indítása";
    if (!wanted) {
      if (recognition) recognition.stop();
      return;
    }

    finals = 0;
    sawAudio = false;
    restartFailures = 0;
    recognition = new Recognition();
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    recognition.continuous = !isMobile;
    recognition.interimResults = true;
    recognition.lang = LANG;
    row(sttResults, "Mód", "pass", `continuous=${recognition.continuous} (mobil=${isMobile})`);
    row(sttResults, "Végleges eredmény", "wait", "engedélyre vagy beszédre várok…");

    recognition.onstart = () => log("onstart");
    recognition.onaudiostart = () => {
      sawAudio = true;
      restartFailures = 0;
      row(sttResults, "Mikrofon", "pass", "él, jön a hang");
      log("onaudiostart");
    };
    recognition.onspeechstart = () => log("onspeechstart");
    recognition.onnomatch = () => row(sttResults, "Utolsó esemény", "warn", "hallott valamit, de nem értette");

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) {
        finals += 1;
        heard.classList.remove("interim");
        heard.textContent = final.trim();
        // Sticky: once a sentence came through, that fact stands whatever
        // happens in the quiet cycles after it.
        row(sttResults, "Végleges eredmény", "pass", `${finals} db. Utolsó: „${final.trim()}”`);
        verdict("felismerés", "pass");
        log(`FINAL: ${final.trim()}`);
      } else if (interim) {
        heard.classList.add("interim");
        heard.textContent = interim;
        log(`interim: ${interim.slice(0, 60)}`);
      }
    };

    recognition.onerror = (event) => {
      // The error string is the whole point here, so it is shown verbatim.
      const explanation = {
        "not-allowed": "a mikrofon engedélye nincs megadva",
        "service-not-allowed": "a böngésző nem érte el a felismerő szolgáltatást (ilyen egy Google API-kulcs nélküli Chromium build)",
        network: "a felismerő szolgáltatás nem elérhető a hálózaton",
        "audio-capture": "nincs elérhető mikrofon",
        aborted: "megszakítva (rendszerint mi állítottuk le)",
        "no-speech": "nem hallott beszédet",
      }[event.error];
      const fatal = !["no-speech", "aborted"].includes(event.error);
      row(sttResults, fatal ? "Felismerő hiba" : "Utolsó esemény", fatal ? "fail" : "warn",
        `${event.error}${explanation ? ` — ${explanation}` : ""}` +
          (fatal ? "" : " — ez önmagában nem baj, a csend is ilyet ad"));
      if (fatal) verdict("felismerés", "fail");
      log(`onerror: ${event.error}`);
    };

    recognition.onend = () => {
      log("onend");
      if (wanted) {
        // Exactly what the real page does: a phrase ending is not the end of
        // dictation, but a repeated failure has to back off instead of spinning.
        if (finals > 0 && restartFailures === 0) log("csendes ciklus, újraindítás");
        if (restartFailures >= 8) {
          wanted = false;
          sttBtn.setAttribute("aria-pressed", "false");
          sttBtn.textContent = "Felismerés indítása";
          row(sttResults, "Újraindítás", "fail", "nyolc próba után sem indult el, feladtam");
          verdict("felismerés", "fail");
          return;
        }
        const delay = Math.min(5000, 200 * 2 ** restartFailures);
        restartFailures += 1;
        setTimeout(() => {
          if (!wanted) return;
          try {
            recognition.start();
            log(`újraindítva ${delay} ms után`);
          } catch (error) {
            row(sttResults, "Újraindítás", "fail", String(error));
            verdict("felismerés", "fail");
          }
        }, delay);
        return;
      }
      if (finals === 0) {
        row(sttResults, "Végleges eredmény", "fail",
          sawAudio ? "a mikrofon élt, de végleges eredmény nem jött" : "a mikrofon meg sem szólalt");
        verdict("felismerés", "fail");
      }
    };

    try {
      recognition.start();
    } catch (error) {
      row(sttResults, "Felismerés", "fail", String(error));
      verdict("felismerés", "fail");
    }
  });

  document.getElementById("copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      log("napló a vágólapra másolva");
    } catch {
      log("a vágólap nem elérhető — jelöld ki kézzel");
    }
  });

  log(`önteszt betöltve, nyelv: ${LANG}`);
})();
