# Background Music Player — GNOME Shell Extension Plan

> Target: GNOME Shell 46 (Wayland) · GJS 1.80 · GStreamer 1.24
> UUID (proposed): `background-music-player@rahul.local`

## Progress Tracker

| #  | Phase                                   | Status         | Notes |
|----|-----------------------------------------|----------------|-------|
| 0  | Setup & skeleton                        | ✅ Done        | Verified in headless shell |
| 1  | Panel indicator + menu layout           | ✅ Done        | Layout verified via in-shell screenshots (docs/menu.png) |
| 2  | Player engine (GStreamer daemon + IPC)  | ✅ Done        | Load/play/pause verified from shell (headless, volume 0); audible check pending |
| 3  | Music list (folder scan)                | ✅ Done        | Verified in headless shell: lazy scan, paging (200/page), symlink loop, missing/empty folder |
| 4  | Player controls + seek bar              | ✅ Done        | 20 playlist unit tests + 26 headless e2e checks passed |
| 5  | Volume control                          | ✅ Done        | 16 headless checks passed; separate stream in Sound settings pending manual check |
| 6  | GSettings persistence                   | ✅ Done        | 20 headless checks + Phase 4 regression passed; real logout/login pending |
| 7  | Autoplay on login                       | ✅ Done        | 6 simulated-login scenarios passed (headless, keyfile settings); real login pending |
| 8  | Lock screen, robustness & polish        | 🟨 In progress | All verified except suspend/resume (manual check) |
| 9  | Preferences window (`prefs.js`)         | ✅ Done        | Opens from menu (headless); 13 harness checks passed; folder dialog manual check pending |
| 10 | MPRIS + media keys                      | ✅ Done        | 29 D-Bus checks passed incl. GNOME media card; physical media keys pending manual check |
| 11 | Packaging & release                     | ✅ Done        | Zip, README, LICENSE, fresh-home install test, v1.0.0 tag |

Status legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked

---

## 1. Overview

Ye extension top panel me ek music icon dikhata hai. Uske dropdown menu me player controls, volume, music list aur autoplay toggle milte hain. Gaane `~/Music` folder se aate hain aur playback background me chalta hai. Last track, position, volume aur modes restart ke baad bhi yaad rehte hain.

### Architecture

```
┌──────────────────────── gnome-shell process ────────────────────────┐
│                                                                      │
│  extension.js ──► Indicator (PanelMenu.Button)                       │
│       │             ├─ NowPlaying + Controls + SeekBar               │
│       │             ├─ ── separator ──                               │
│       │             ├─ Volume slider                                 │
│       │             ├─ Music List (PopupSubMenu, lazy)               │
│       │             └─ Autoplay toggle (PopupSwitchMenuItem)         │
│       │                                                              │
│       ├─► Playlist (queue, next/prev, loop, shuffle)                 │
│       ├─► Scanner (async Gio enumerate, audio/* filter)              │
│       ├─► Gio.Settings (GSettings schema)                            │
│       └─► PlayerClient ──── JSON lines over stdin/stdout ────┐       │
└──────────────────────────────────────────────────────────────┼───────┘
                                                               ▼
                                   ┌──────── player-daemon.js (gjs -m) ───────┐
                                   │  GStreamer playbin → PipeWire/Pulse      │
                                   │  commands: load/play/pause/seek/volume   │
                                   │  events: state/position/duration/eos/err │
                                   └──────────────────────────────────────────┘
```

### Key decisions

**D1. `PanelMenu.Button` ya Quick Settings? → `PanelMenu.Button` (alag indicator)**
- Quick Settings ka `QuickMenuToggle` chhote toggles ke liye bana hai. Usme seek bar, controls ki row aur ek lambi scrollable music list theek se fit nahi hoti.
- `PanelMenu.Button` ka menu poora apna hota hai, isliye layout, width aur scroll par full control milta hai.
- GNOME ke date/notification menu me jo media widget hai, wo MPRIS se khud dikhne lagega (Phase 10). Isliye Quick Settings me hone ka fayda waise bhi mil jayega.
- Indicator ko `Main.panel.addToStatusArea(uuid, indicator, 0, 'right')` se right side me (system menu ke paas) rakhenge.

**D2. GStreamer shell process ke andar ya alag process me? → alag process (daemon)**
- Wayland par gnome-shell hi compositor hai. Agar decoder crash ho ya main loop block ho, toh **poora session logout** ho sakta hai aur saari apps band ho jayengi. Alag process me crash sirf daemon ka hoga, aur extension use dobara start kar dega.
- Decoding ka kaam shell ke main loop se bahar rahega, isliye UI smooth rahega.
- IPC ke liye `Gio.Subprocess` ke stdin/stdout pipes par line-delimited JSON use karenge. D-Bus name, service file, kuchh nahi chahiye. Pipe band hote hi daemon khud exit ho jata hai, toh orphan process nahi bachte.
- Isme kya kharch hai: thoda extra code (protocol, restart logic).
- Alternative: GStreamer ko seedha shell me `import Gst from 'gi://Gst?version=1.0'` se chalana. Ye simple hai par risky hai, isliye nahi chuna.

**D3. Logic kahan rahega?**
- Daemon "dumb" playback engine hai: jo bola jaye wahi play karta hai aur events bhejta hai.
- Playlist, loop/shuffle aur settings extension side par rahenge. Isse daemon chhota rehta hai aur state ka ek hi source rehta hai (GSettings).

**D4. Persistence → GSettings.** Schema extension ke `schemas/` folder me rahega. `this.getSettings()` se access karenge.

---

## 2. Project Structure

```
background-music-player/
├── PLAN.md
├── metadata.json             # uuid, name, shell-version ["46"], settings-schema
├── extension.js              # Extension class: enable()/disable(), sab ko wire karta hai
├── prefs.js                  # Adw preferences window (music folder, recursive scan, etc.)
├── stylesheet.css            # controls row, seek bar, list ki styling
├── lib/
│   ├── indicator.js          # PanelMenu.Button + poora menu UI
│   ├── controls.js           # NowPlaying label, prev/play/next, loop/shuffle buttons
│   ├── seekBar.js            # Slider + "1:23 / 4:56" time labels
│   ├── musicList.js          # PopupSubMenuMenuItem, lazy load + scrollable list
│   ├── scanner.js            # async folder scan, audio file filter
│   ├── playlist.js           # queue, current index, next/prev, loop/shuffle rules
│   ├── playerClient.js       # daemon spawn/kill/restart, JSON send/receive, signals
│   └── mpris.js              # (Phase 10) org.mpris.MediaPlayer2 D-Bus export
├── daemon/
│   └── player-daemon.js      # gjs -m script: GStreamer playbin + JSON protocol
├── schemas/
│   └── org.gnome.shell.extensions.background-music-player.gschema.xml
└── scripts/
    ├── install.sh            # symlink into ~/.local/share/gnome-shell/extensions + compile schemas
    ├── nested.sh             # nested Wayland session launch
    └── pack.sh               # gnome-extensions pack
```

### GSettings keys (draft)

| Key                | Type | Default    | Purpose |
|--------------------|------|------------|---------|
| `music-folder`     | `s`  | `''` (empty = XDG Music dir) | Scan karne wala folder |
| `recursive-scan`   | `b`  | `false`    | Subfolders bhi scan karne hain ya nahi |
| `last-track-uri`   | `s`  | `''`       | Last selected/playing track |
| `last-position-ms` | `x`  | `0`        | Resume position |
| `volume`           | `d`  | `0.7`      | Extension ka apna volume (0.0–1.0, perceptual; daemon cube karta hai) |
| `muted`            | `b`  | `false`    | Mute state |
| `loop-mode`        | `s`  | `'none'`   | `none` / `one` / `all` |
| `shuffle`          | `b`  | `false`    | Shuffle on/off |
| `autoplay`         | `b`  | `false`    | Login par autoplay |
| `resume-position`  | `b`  | `true`     | Autoplay me last position se resume karein |

### Daemon protocol (draft)

Har message ek line ka JSON hoga.

- Extension → daemon: `{"cmd":"load","uri":"file:///…","autoplay":true,"startMs":0}`, `play`, `pause`, `stop`, `{"cmd":"seek","ms":12000}`, `{"cmd":"volume","value":0.6}`, `quit`
- Daemon → extension: `{"ev":"ready"}`, `{"ev":"state","value":"playing|paused|stopped"}`, `{"ev":"duration","ms":…}`, `{"ev":"position","ms":…}` (sirf playing ke time, ~500 ms par), `{"ev":"tags","title":…,"artist":…}`, `{"ev":"eos"}`, `{"ev":"error","message":…}`

---

## 3. Phases

### Phase 0 — Setup & skeleton
**Goal:** Ek khali extension jo nested session me enable ho jaye aur bina error ke disable ho jaye.

- [x] `metadata.json` banao (`uuid`, `name`, `description`, `shell-version: ["46"]`, `settings-schema`, `url`)
- [x] ESM `extension.js`: `export default class extends Extension { enable() {} disable() {} }`
- [x] GSettings schema XML me upar ki saari keys likho, phir `glib-compile-schemas schemas/` chalao
- [x] `scripts/install.sh`: repo ko `~/.local/share/gnome-shell/extensions/<uuid>` par symlink kare aur schemas compile kare
- [x] `scripts/nested.sh`: nested Wayland session start kare (Section 4 dekho)
- [x] `git init` + `.gitignore` (`schemas/gschemas.compiled`, `*.zip`)

**Done when:** Nested session me `gnome-extensions enable <uuid>` chale, aur `journalctl` me koi error na aaye.

---

### Phase 1 — Panel indicator + menu layout
**Goal:** Top bar me icon dikhe, click par menu khule, aur saare sections placeholder ke roop me dikhein.

- [x] `lib/indicator.js`: `PanelMenu.Button` subclass (`GObject.registerClass`) me `St.Icon` (`audio-x-generic-symbolic`)
- [x] `Main.panel.addToStatusArea()` se right side me add karo
- [x] Menu sections ka order: NowPlaying + controls (placeholder) → `PopupSeparatorMenuItem` → volume (placeholder) → "Music List" submenu → "Autoplay on login" `PopupSwitchMenuItem`
- [x] `disable()` me `indicator.destroy()` aur saare references `null` karo
- [x] (Phase 7 se pehle hi) Autoplay switch ko `autoplay` GSettings key se jod diya

**Done when:** Menu ka layout upar wale order me dikhe, aur enable/disable 5 baar karne par bhi duplicate icon na bane aur koi error na aaye.

---

### Phase 2 — Player engine (GStreamer daemon + IPC)
**Goal:** Extension se ek local file play/pause ho sake, aur playback alag process me chale.

- [x] `daemon/player-daemon.js`: `Gst.init(null)`, phir `playbin` element (`video-sink` ko `fakesink` set karo taaki video wali files par window na khule)
- [x] stdin se commands padho (`Gio.DataInputStream.read_line_async`), stdout par events JSON me likho
- [x] Bus watch: `EOS`, `ERROR`, `STATE_CHANGED`, `DURATION_CHANGED`, `TAG`
- [x] Playing ke time position ka timer (~500 ms), paused/stopped par band
- [x] stdin EOF par pipeline ko `NULL` state me karke exit karo
- [x] `lib/playerClient.js`: `Gio.Subprocess` (`STDIN_PIPE | STDOUT_PIPE`) se `gjs -m daemon/player-daemon.js` spawn karo; signals ke liye `EventEmitter` (`resource:///org/gnome/shell/misc/signals.js`) use karo
- [x] Daemon crash ho toh restart karo (backoff ke saath: 1s, 2s, 5s, max 3 baar), phir error state dikhao
- [x] `disable()` me pehle `quit` command bhejo, phir timeout ke baad `force_exit()`
- [x] Play button wired: `last-track-uri` setting wala track load/play/pause karta hai (Phase 3 tak testing ke liye), title tags se update hota hai

**Done when:** Ek hardcoded mp3 extension se play/pause ho. `kill -9 <daemon-pid>` karne par shell stable rahe aur daemon restart ho jaye. Disable karne ke baad `pgrep -f player-daemon` kuchh na dikhaye.

---

### Phase 3 — Music list (folder scan)
**Goal:** "Music List" par click karne par hi folder scan ho, aur gaane par click karne se wo play ho.

- [x] `lib/scanner.js`: `GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC)`, aur `music-folder` set ho toh wahi folder
- [x] `enumerate_children_async` + `next_files_async` (batch me). Main loop block nahi hona chahiye
- [x] Filter: content-type `audio/*` (mp3, flac, ogg, opus, wav, m4a), naam ke hisaab se sort
- [x] Optional recursive scan (`recursive-scan` key), symlink loops se bachne ke liye visited set rakho
- [x] `lib/musicList.js`: submenu khulne par (`open-state-changed`) scan karo, "Scanning…" dikhao, phir items daalo
- [x] Lambi list ke liye scroll (`St.ScrollView` + max-height CSS)
- [x] Empty state "No music found in ~/Music" aur folder na mile toh error state
- [x] Current track ke aage ornament/highlight (`PopupMenu.Ornament.DOT`)
- [x] Item par click karne par `playlist.setQueue(list, index)` aur `player.load(uri)`

**Done when:** `~/Music` me 3–4 test files rakhne par list dikhe aur click se gaana play ho. 1000+ files par bhi menu hang na ho. Empty folder par empty-state message aaye.

> Note: Abhi `~/Music` khali hai. Testing ke liye kuchh sample files daalni hongi.

---

### Phase 4 — Player controls + seek bar
**Goal:** Poore player controls kaam karein.

- [x] NowPlaying label: tag se title/artist, warna filename. Lamba naam ellipsize ho
- [x] Prev / Play-Pause / Next buttons (`St.Button` + symbolic icons). Play/pause ka icon state ke hisaab se badle
- [x] `lib/playlist.js`:
  - [x] `next()` / `prev()`. Prev ka rule: agar track 3s se zyada chal chuka hai toh usi track ki shuruaat par jao, warna pichhla track
  - [x] Loop `none`: last track ke baad stop. `one`: wahi track repeat. `all`: list ke end se wapas start
  - [x] Shuffle: shuffled order banao aur current track ko order me sabse pehle rakho
  - [x] EOS par loop mode ke hisaab se aage badho
- [x] Loop button (icons: `media-playlist-repeat-symbolic` / `media-playlist-repeat-song-symbolic`) aur shuffle toggle
- [x] `lib/seekBar.js`: `Slider` (`resource:///org/gnome/shell/ui/slider.js`) + `0:00 / 0:00` labels
  - [x] Jab user slider drag kar raha ho, tab position updates ignore karo (taaki slider jump na kare). Release par `seek` bhejo
  - [x] Menu band ho toh UI update skip karo (CPU bachane ke liye)

**Done when:** Saare buttons kaam karein. Teeno loop modes aur shuffle ka behaviour sahi ho. Seek accurate ho, aur slider drag karte waqt jhatka na lage.

---

### Phase 5 — Volume control
**Goal:** Extension ka apna volume ho, system volume se alag.

- [x] Menu me volume row: icon + `Slider`
- [x] `playbin.volume` set karo. Slider ki value ko cubic curve se map karo (`GstAudio.StreamVolume.convert_volume`, CUBIC → LINEAR) taaki volume badhna natural lage
- [x] Icon volume level ke hisaab se badle (muted/low/medium/high). Icon click karne par mute toggle ho
- [x] Slider move karte waqt settings write ko debounce karo (Phase 6 ke saath jodna hai)

**Done when:** Slider se sirf is player ka volume badle. System volume aur doosri apps par asar na pade (`pavucontrol` / Settings → Sound me alag stream dikhe).

---

### Phase 6 — GSettings persistence
**Goal:** Restart ke baad sab kuchh yaad rahe.

- [x] Extension start hone par settings padho: volume, loop, shuffle, last track
- [x] Track change par `last-track-uri` save karo (Phase 3 me hi ho gaya)
- [x] Loop/shuffle: settings se load, change par save, `changed::` se UI sync (Phase 4 me ho gaya)
- [x] Volume + mute: load, debounced save, external change sync (Phase 5 me ho gaya)
- [x] Restart ke baad play dabane par folder scan karke last track ke aas-paas queue dobara banti hai (next/prev kaam karte hain)
- [x] Position save karne ke mauke: pause par, track change par, `disable()` me, aur playing ke time har ~10s (har position event par nahi)
- [x] Volume/loop/shuffle change par save karo (volume ke liye debounce)
- [x] Settings ke `changed::` signals sun ke UI sync karo (prefs window se change aaye tab ke liye)
- [x] Last track ki file delete ya move ho gayi ho toh gracefully clear karo
- [x] Start par last track paused state me saved position par preload hota hai (`restoreSession()`); Phase 7 isi ko `autoplay: true` se call karega
- [x] Daemon fix: chalte gaane me seek karne par faltu `paused` event nahi aata (seeking flag)

**Done when:** Gaana chalao, seek karo, volume aur loop badlo, phir logout/login karo. Menu me wahi track, position, volume aur loop dikhne chahiye. Check: `gsettings --schemadir schemas/ list-recursively org.gnome.shell.extensions.background-music-player`.

---

### Phase 7 — Autoplay on login
**Goal:** `autoplay` ON ho toh login ke baad last track apne aap chale.

- [x] Menu ke "Autoplay on login" switch ko `autoplay` setting se jodo (`toggled` + `changed::autoplay`; PopupSwitchMenuItem ki state GObject property nahi hai, isliye `settings.bind` nahi)
- [x] Ye check karo ki enable() **session start** par hua hai ya user ne extension toggle kiya hai. Session start par `Main.layoutManager._startingUp` true hota hai, tab `startup-complete` signal ka wait karo. Sirf isi case me autoplay karo
- [x] Startup ke baad thoda delay (~2–3s), taaki PipeWire/Pulse ready ho jaye. Pehli baar fail ho toh retry karo
- [x] `resume-position` ON ho toh last position se start karo
- [x] Last track missing ho toh kuchh mat chalao, sirf log karo
- [x] Delay ke beech user khud play dabaye toh autoplay dobara load nahi karta

**Done when:** Autoplay ON karke logout/login karo, gaana apne aap chale. Autoplay OFF par na chale. Extension manually disable/enable karne par autoplay trigger na ho.

---

### Phase 8 — Lock screen, robustness & polish
**Goal:** Real use me stable rahe, aur screen lock hone par music na ruke.

- [x] **Lock screen:** Default me GNOME lock par extensions disable kar deta hai, jisse daemon kill ho jayega aur music band ho jayega. Iska fix:
  - [x] `metadata.json` me `"session-modes": ["user", "unlock-dialog"]` daalo
  - [x] `Main.sessionMode.connect('updated')` sun ke `unlock-dialog` mode me sirf indicator chhupao, player chalta rahe
  - [x] Ye behaviour README me likho (extensions.gnome.org review me iska justification dena padta hai) — README ke "Notes for reviewers" me
- [x] Unsupported/corrupt file: error notification (`Main.notify`) dikhao aur next track par jao (lagatar 3 fail ke baad ruk jao) — codec hint ke saath
- [ ] Suspend/resume ke baad playback state sahi rahe — headless me test nahi ho sakta, manual check baaki
- [x] Saare signal connections track karo aur `disable()` me disconnect karo. `GLib.timeout_add` ke IDs bhi remove karo
- [x] Panel icon par scroll karne se volume badle, middle-click se play/pause (optional)
- [x] Light/dark theme me styling check karo — ZorinBlue-Light par screenshot se verify kiya; off toggles color ki jagah opacity se dim hote hain
- [ ] Translations ki tayyari (`gettext`, optional)

- [x] **Rebase fix:** lock par GNOME baaki extensions disable karta hai aur unke *baad* wale extensions (ye wala bhi) disable → re-enable karta hai. Locked state me `disable()` daemon ko 10s ke liye park karta hai aur turant aane wala `enable()` use adopt kar leta hai, isliye music nahi rukta
- [x] Known GNOME 46 issue: lock ke waqt koi bhi extension menu khula ho toh log me `this.bin is undefined` aata hai (plain `PanelMenu.Button` ke saath bhi reproduce hota hai). Functional asar nahi

**Done when:** Gaana chalte hue screen lock/unlock karo, music na ruke. Suspend/resume ke baad sab theek rahe. 10 baar enable/disable karne par koi leaked process ya signal na bache, aur logs saaf hon.

---

### Phase 9 — Preferences window (`prefs.js`)
**Goal:** Settings GUI se badli ja sakein.

- [x] `ExtensionPreferences` + `Adw.PreferencesPage`
- [x] Music folder chooser (`Gtk.FileDialog.select_folder`) + "Reset to default" — dialog khud headless me test nahi ho sakta, manual check baaki
- [x] Recursive scan, autoplay aur resume-position ke switches (`settings.bind`, dono taraf test kiye)
- [x] Menu me "Settings…" item jo `this.openPreferences()` call kare

**Done when:** `gnome-extensions prefs <uuid>` se window khule, aur folder badalne par agle scan me naya folder dikhe.

---

### Phase 10 — MPRIS + media keys
**Goal:** GNOME ka date-menu media widget, keyboard media keys aur `playerctl` is player ke saath kaam karein.

- [x] `lib/mpris.js`: `Gio.DBus.session.own_name('org.mpris.MediaPlayer2.BackgroundMusicPlayer')`
- [x] `org.mpris.MediaPlayer2` aur `org.mpris.MediaPlayer2.Player` interfaces export karo: `PlayPause`, `Next`, `Previous`, `Seek`, `SetPosition`, aur properties `PlaybackStatus`, `Metadata`, `Volume`, `LoopStatus`, `Shuffle`, `Position`
- [x] Property change par `PropertiesChanged` signal emit karo
- [x] `disable()` me `unown_name` + `unexport`

- [x] LoopStatus/Shuffle/Volume seedhe GSettings se map (menu, prefs aur MPRIS hamesha ek jaise); Volume set karne se unmute hota hai
- [x] `Seek` end ke paar = Next (spec), `SetPosition` purane TrackId ko ignore karta hai, `Seeked` signal menu seek / Previous-restart / MPRIS teeno se
- [x] `CanPlay` sirf track hone par true, isliye bina track ke GNOME ka player card nahi dikhta
- [x] Lock ke rebase ke dauran bhi bus name aur metadata bane rehte hain

**Done when:** `playerctl -p BackgroundMusicPlayer play-pause` kaam kare, media keys kaam karein, aur notification/date menu me player card dikhe.

---

### Phase 11 — Packaging & release
**Goal:** Installable zip bane, aur chahein toh extensions.gnome.org par submit ho sake.

- [x] `scripts/pack.sh`: `gnome-extensions pack --extra-source=lib --extra-source=daemon --schema=schemas/….gschema.xml` — `dist/<uuid>.shell-extension.zip` banata hai (18 files, sirf runtime files)
- [x] README: features, install, lock-screen behaviour, aur daemon process ki wajah — English me (users + EGO reviewers), `docs/menu.png` screenshot ke saath
- [x] Fresh user account par zip install karke test karo — alag khali HOME me zip install karke headless smoke test pass; `gnome-extensions install` schemas khud compile karta hai; pehli baar play me ~2s (GStreamer registry banti hai)
- [x] EGO review guidelines check karo (`disable()` cleanup, `enable()` se pehle koi kaam nahi, koi deprecated API nahi) — self-audit: koi unused import / deprecated API nahi; ek private API (`_startingUp`) README me explain kiya
  - [x] Reviewer ke liye do exceptions explain karo: (1) `playerClient.destroy()` ka 1s grace timer, jo daemon na ruke toh use kill karta hai; (2) lock par 10s ka park timer (`extension.js`) — README ke "Notes for reviewers" me
- [x] Version bump: `metadata.json` me `version-name: 1.0.0` (EGO `version` khud deta hai, isliye hata diya; khali `url` bhi hataya)
- [x] Git: initial commit + local tag `v1.0.0`
- [x] License: GPL-2.0-or-later (`LICENSE` + README)

**Done when:** `gnome-extensions install bmp.zip` se kisi doosri machine/account par bina manual steps ke chal jaye.

---

## 4. Development & Testing Workflow

### Install (dev mode)
```bash
./scripts/install.sh   # symlink + glib-compile-schemas
```
Wayland par main session me naya extension tabhi dikhta hai jab logout/login karo. Isliye development **nested session** me karo.

### Nested Wayland session
```bash
dbus-run-session -- gnome-shell --nested --wayland
# andar ke terminal se:
gnome-extensions enable background-music-player@rahul.local
```
Code badlne ke baad nested window band karke dobara chalao. Ye logout/login se kaafi tez hai.

### Logs
```bash
journalctl -f -o cat /usr/bin/gnome-shell      # extension ke logs (console.log / console.error)
journalctl -f -o cat /usr/bin/gjs              # daemon ke logs (stderr)
```
Nested session ke logs usi terminal me aate hain jisse session start kiya tha.

### Daemon ko alag se test karna
```bash
gjs -m daemon/player-daemon.js
{"cmd":"load","uri":"file:///home/rahul/Music/test.mp3","autoplay":true}
```

### Release zip
```bash
./scripts/pack.sh      # → dist/background-music-player@rahul.local.shell-extension.zip
gnome-extensions install --force dist/*.zip
```

### Useful tools
- Looking Glass: `Alt+F2` → `lg` (live JS console, actors inspect karne ke liye)
- `gsettings --schemadir schemas/ monitor org.gnome.shell.extensions.background-music-player`
- `playerctl -l` (MPRIS check)
- `pgrep -af player-daemon` (leaked process check)

---

## 5. Risks & Known Limitations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Shell crash = Wayland session logout | Saari apps band | GStreamer alag daemon me (D2). Extension code me try/catch. Pehle nested session me test |
| Screen lock par extension disable | Music ruk jata hai | `session-modes: ["user","unlock-dialog"]` + lock par daemon park/adopt, kyunki GNOME baaki extensions ke saath ise bhi disable/re-enable karta hai (Phase 8) |
| GStreamer codecs missing (doosri machine par) | Kuchh formats na chalein | Error event par notification dikhao: "codec missing: gstreamer1.0-libav / plugins-ugly install karein". Is machine par mp3/flac/ogg/aac sab available hain |
| `disable()` me cleanup bhoolna | Duplicate icons, leaked processes/timers, EGO rejection | Har connect/timeout/subprocess track karo. Phase 1 aur 8 me enable/disable loop test |
| Badi music library | Menu freeze | Async batched scan + lazy load + scroll. Zaroorat ho toh list cap karke "Show more" |
| Autoplay ke time audio server ready na ho | Autoplay silently fail | `startup-complete` ka wait + delay + retry (Phase 7) |
| GNOME version upgrade (47+) | APIs toot sakti hain | `shell-version` explicitly list karo. Upgrade par nested session me test karo. Private APIs (`_startingUp`) kam se kam use karo |
| Daemon orphan ho jaye | Background me music chalta rahe | stdin EOF par daemon self-exit. Disable me `force_exit` |

---

## 6. Open Questions (abhi ke default assumptions)

1. **Lock screen par music chalna chahiye?** Assume kiya hai **haan**, isliye Phase 8 me `unlock-dialog` mode hai.
2. **Music List flat ho ya folder-wise?** Assume kiya hai **flat list** (recursive scan ON ho toh relative path dikhega).
3. **Autoplay me position resume ho ya track shuru se chale?** Default **resume** hai, ise `resume-position` key se badal sakte hain.
4. **Supported formats:** content-type `audio/*` jo GStreamer chala sake. Alag playlists (m3u) abhi scope me nahi hain.
