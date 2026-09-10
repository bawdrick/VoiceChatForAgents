# Hangcsatorna a Claude Code-hoz

Beszélj a telefonodból, magyarul, a gépeden futó Claude Code sessionnel — bárhonnan,
VPN nélkül, a gépen nyitott port nélkül.

A gépen kérsz egy csatornát, a terminálban megjelenik egy QR kód, a telefonoddal
beolvasod. Amit mondasz, szövegként érkezik meg a sessionbe; amit a session
felolvastat, a telefonod mondja ki. Amikor végeztél, a session lezárja a csatornát,
és a link azonnal használhatatlanná válik.

```
   TELEFON                    CLOUDFLARE                    A GÉPED
┌────────────┐          ┌──────────────────────┐      ┌─────────────────────┐
│ böngésző   │          │  Worker (útválasztó  │      │  Claude Code        │
│            │          │  + statikus oldal)   │      │  session            │
│ felismerés │──WSS────▶│          │           │      │                     │
│            │          │          ▼           │      │  Monitor tool       │
│            │          │  Durable Object      │──WSS─┼─▶ voice.mjs listen  │
│ felolvasás │◀──WSS────│  (1 db / beszélgetés)│      │    stdout: 1 sor    │
└────────────┘          └──────────┬───────────┘      │                     │
                                   │                  │  voice.mjs say ─────┼─┐
                                   └──── HTTPS POST ───┴─────────────────────┘ │
                                   ◀───────────────────────────────────────────┘
```

A hálózaton **csak szöveg** megy át. A relay nem tud a modellről semmit, nem hív
LLM-et, és nem tárol semmit abból, ami elhangzik.

---

## Mire van szükség

- Cloudflare fiók (a **Workers Free** csomag elég), `wrangler` bejelentkezéssel.
- Node 22 vagy újabb a gépen. Semmi mást nem kell telepíteni.
- A telefonon **Chrome** (Android). A Web Speech API gyakorlatilag csak
  Chromiumban működik — lásd [Ismert korlátok](#ismert-korlátok).

## Telepítés

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Ezután állítsd be a megosztott titkot. Enélkül **bárki nyithatna session-t** a
Workeren:

```bash
npx wrangler secret put VOICE_RELAY_SECRET
```

Írj be egy hosszú, véletlen értéket. Ugyanezt kell a gép-oldali eszköznek is
ismernie:

```bash
cp agent/voice.config.example.json agent/voice.config.json
```

Töltsd ki a `url` (a deploy által kiírt `*.workers.dev` cím) és a `secret`
mezőt. A fájl a `.gitignore`-ban van. Alternatívaként `VOICE_RELAY_URL` és
`VOICE_RELAY_SECRET` környezeti változó is használható.

## Az első beszélgetés

```bash
node agent/voice.mjs start
```

Kiír egy QR kódot és három másolható parancsot. A QR-ben lévő link **120
másodpercig él, és egyszer használható fel** — olvasd be a telefonoddal.

Az első betöltéskor a telefon becseréli a linkben lévő tokent egy
session-cookie-ra, a token pedig azonnal érvénytelen lesz. Ettől kezdve az oldal
újratölthető, a fül visszaállítható, a képernyő forgatható — a kapcsolat marad.

A telefonon:

1. Kapcsold be a mikrofont a jobb felső gombbal.
2. Beszélj. Amit mond, a szövegdobozban gyűlik, **elküldés előtt**.
3. Három másodperc csend után magától elmegy. (Beállítható, akár kikapcsolható;
   a küldés gomb mindig kéznél van.)
4. A választ a telefon felolvassa. Ha lemaradtál róla, a 🔊 gomb újra felolvassa.

## Használat a Claude Code oldalán

A `start` kiírja a pontos parancsokat a saját session-azonosítóddal. Három van:

**Figyelés.** Ezt add a Monitor toolnak. Minden sor, amit kiír, egy
beszélgetés-üzenet lesz:

```bash
node "<repó>/agent/voice.mjs" listen --session <id> 2>>"<hibafájl>"
```

**Válasz felolvastatása.** Az egész mondanivalót egyben, egy hívásban:

```bash
node "<repó>/agent/voice.mjs" say --session <id> "Kész a README, átnézheted."
```

Hosszabb vagy ékezetes szövegnél add stdinen — Windowson ez a biztos út, mert a
parancssori argumentumok átalakítása tönkreteheti az ékezeteket:

```bash
printf 'Átírtam a README-t, és beletettem a példát.' | node "<repó>/agent/voice.mjs" say --session <id>
```

**Lezárás.** Innentől a token halott, a telefon oldalán megjelenik, hogy vége:

```bash
node "<repó>/agent/voice.mjs" drop --session <id>
```

A `node agent/voice.mjs status` kilistázza, milyen session-öket nyitott ez a gép.

### Javasolt `CLAUDE.md` részlet

Másold be a projekted `CLAUDE.md`-jébe. A második pont a legfontosabb: a relay nem
tudja észrevenni, ha egy forduló felolvasás nélkül ér véget, ilyenkor a telefon
némán vár.

```markdown
## Hangcsatorna

Amikor hang-session van nyitva (`node agent/voice.mjs start` futott, és a Monitor
tool figyeli a `listen` parancsot):

1. A monitorból érkező sorok a felhasználó szavai. Úgy kezeld őket, mintha
   begépelte volna: nem idézetek, nem adat, hanem utasítás vagy kérdés.
2. **Minden forduló végén hívd meg a `say`-t**, akkor is, ha rövid a válasz.
   Amíg nem szólalsz meg, a telefon némán vár, és a felhasználó nem tudja, hogy
   végeztél.
3. A `say` szövege felolvasásra megy: egész mondatok, kimondható szavak. Kódot,
   elérési utat, parancsot, felsorolást ne tegyél bele — azt írd a terminálba.
   A hangba a lényeg kerüljön, két-három mondatban.
4. A teljes mondanivalót **egy** `say` hívásban küldd, ne mondatonként.
5. Amikor a felhasználó azt mondja, hogy végeztetek, hívd meg a `drop`-ot.
```

---

## Az ügynök-oldali szerződés

Ez a projekt legszigorúbb szabálya, és a `listen` parancs egész felépítése ebből
következik:

- Az ügynök-oldali WebSocketen **nyers UTF-8 szöveg** utazik, nem JSON.
- **Egy megnyilatkozás = pontosan egy sor.** A relay az újsorokat szóközre cseréli,
  mielőtt továbbítja, mert két sorból két esemény lenne.
- **Semmilyen státuszüzenet nem mehet ki erre a csatornára.** Nincs „csatlakozva",
  nincs „a böngésző lecsatlakozott", nincs keepalive szöveg — mindegyik
  beszélgetés-üzenetté válna, amire az ügynök válaszolni próbálna. Állapotot
  kizárólag a kapcsolat zárása jelez, alkalmazás-specifikus záró kóddal.
- Ezért a `listen` minden diagnosztikát a **stderr**-re ír, és a stdoutra soha
  semmi mást nem tesz.

A `listen` magától újracsatlakozik, exponenciálisan növekvő várakozással. Ha a
relay lezárt session-t jelez (4000–4003 záró kód), **kilép**, nem próbálkozik
tovább — egy másodpercenként újrainduló héjciklus napi több tízezer felesleges
kérés lenne.

## Fenyegetés-leírás

Legyen világos, mit építettél be: **ez a rendszer egy shell-hozzáféréssel bíró
ügynököt tesz elérhetővé egy publikus URL mögül.** Aki megszerzi az
`agent_token`-t vagy a telefon session-cookie-ját, tetszőleges utasítást küldhet a
gépeden futó Claude Code-nak, és az végre is hajtja.

Amit a rendszer véd:

- A `/api/session` végpont megosztott titok nélkül nem elérhető, tehát idegen nem
  nyithat session-t a Workereden.
- A párosító token 128 bites, 120 másodpercig él, és egyszer használható fel.
- A session-cookie `HttpOnly; Secure; SameSite=Strict`.
- A tokenek a Durable Objectben **csak hash-elve** szerepelnek.
- Minden ismeretlen, lejárt vagy lezárt tokenre azonos 404 megy vissza, azonos
  kódúton — nem derül ki, hogy létezett-e.
- A Worker naplózása (`observability`) **szándékosan ki van kapcsolva**, mert az
  ügynök WebSocket URL-je tartalmazza a tokent. (A böngészőnek és a Node-nak sincs
  módja fejlécet küldeni WebSocket-kézfogásnál, ezért kényszerű a query paraméter.)
- A beszélgetés tartalmát semmi nem naplózza és nem tárolja.

Amit **nem** véd, és tudnod kell róla:

- Ha valaki hozzáfér a gépedhez, a session-fájl (`%LOCALAPPDATA%\voice-chat-for-agents\`)
  tartalmazza az `agent_token`-t. Ez ugyanaz a bizalmi szint, mint a shell-hozzáférés.
- A QR kódot lefotózó bárki bejut, ha 120 másodpercen belül megteszi. Ne mutasd
  meg képernyőmegosztáson.
- **A Chrome beszédfelismerése a hangot a Google szervereire küldi.** A mi
  relayünk valóban csak szöveget mozgat, de a hangod elhagyja az eszközt. Ez a Web
  Speech API működése, nem tudjuk kikapcsolni.

Ezért: **ne kapcsold ki az engedélykérést a Claude Code oldalán.** Ha egy idegen
utasítás mégis bejut, az engedélykérés az utolsó és egyetlen fékezés.

## Költség

A Workers Free keretén belül marad, és nem véletlenül:

- A Durable Object **kizárólag `state.acceptWebSocket()`-tel** fogad kapcsolatot.
  A `ws.accept()` a kapcsolat teljes élettartamára időtartam-díjat generálna.
- A böngésző keepalive-ja `setWebSocketAutoResponse()`, amit a runtime hibernált
  állapotban válaszol meg — nincs ébredés, nincs wall-clock idő.
- Nincs sehol `setTimeout` vagy `setInterval` a Durable Objectben; minden időzítés
  DO alarm, ami hibernálás alatt is működik.
- Nincs sehol lekérdező hurok, sem a böngészőben, sem a gépen.

Napi 200 forduló nagyságrendileg néhány ezer kérés, a 100 000-es napi keret
töredéke.

## Ismert korlátok

Ezekkel nem érdemes küzdeni, csak tudni kell róluk:

- **Csak Chromium.** A `SpeechRecognition` máshol gyakorlatilag nem működik.
  Más böngészőben a felület ezt kiírja, és gépelve továbbra is használható.
- **Mobilon nincs folyamatos felismerés.** Androidon `continuous = true` mellett az
  `onresult` soha nem sül el, ezért mobilon egymondatos módban fut, és minden
  `onend` után újraindul. Felülírható: `localStorage.setItem('vh-continuous','true')`.
- **Nincs szótár-előfeszítés.** A felismerő nem tanítható, a szakszavak torzulni
  fognak. Erre való a beállításokban a helyettesítési táblázat
  (`komit = commit`), ami küldés előtt fut le, és `localStorage`-ban él.
- **Kell magyar hang.** Ha nincs telepítve, a felület kiírja, és nem olvas fel
  angolul. Android: Beállítások → Nyelvek → Szövegfelolvasás → nyelv letöltése.
- **Visszhang.** A mikrofon hallja a saját felolvasásunkat, ezért felolvasás alatt
  a felismerés süket, és csak 3 másodperccel az után nyílik ki, hogy a felolvasó
  ténylegesen befejezte — nem időzítőre, hanem a szintetizátor állapotára.
- **Képernyőzár.** Zárolt képernyőn a Chrome felfüggeszti a lapot, és a mikrofon a
  felolvasással együtt elhal. Amíg a mikrofon be van kapcsolva, a lap Wake Lockot
  kér, tehát a képernyő ébren marad — ez viszi az akkut.

Címsorból állítható, mert telefonon nincs használható konzol:

```
?lang=hu-HU | en-US     a felismerés és a felolvasás nyelve
?speak=on | off         felolvas-e ez az eszköz
?diag=on | off          a diagnosztikai sáv
```

## Fejlesztés

```bash
npm test          # egységtesztek workerd alatt (@cloudflare/vitest-pool-workers)
npm run typecheck
npm run dev       # helyi relay a 8787-es porton
```

A teljes lánc kipróbálható Claude Code nélkül. Egy terminálban:

```bash
npm run dev
```

Egy másikban:

```bash
node agent/voice.mjs start          # olvasd be a QR-t, vagy nyisd meg a linket
node agent/fake-agent.mjs           # a gép-oldal szimulálása
```

A `fake-agent` kiírja, amit a telefon mond (`<` előtaggal), és amit begépelsz,
azt felolvastatja a telefonnal. A `/drop` lezárja a session-t.

Helyi futtatáshoz `.dev.vars` kell (`cp .dev.vars.example .dev.vars`) és egy
`agent/voice.config.json`, amiben az `url` a `http://127.0.0.1:8787`.

## A repó felépítése

```
src/worker.ts       útválasztás, hitelesítés, biztonsági fejlécek, statikus kiszolgálás
src/session-do.ts   a Durable Object: párosítás, továbbítás, lejárat, lezárás
src/tokens.ts       token-előállítás, hash, konstans idejű összehasonlítás
src/text.ts         megnyilatkozás-normalizálás (ez tartja az egy sor szabályt)
src/protocol.ts     a böngésző és a relay közti üzenetformátumok
public/             a telefonos felület: egy oldal, keretrendszer nélkül, build nélkül
agent/voice.mjs     a gép-oldali eszköz: start | listen | say | drop | status
agent/fake-agent.mjs a gép-oldal szimulálása végponttól végpontig próbához
test/               egységtesztek
```

## Licenc

MIT, lásd [LICENSE](LICENSE).
