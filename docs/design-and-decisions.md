# Outlook Steganography Add-in – Design & Decisions

_Living document. Update the decision log whenever a choice is made, changed or reversed._

| | |
|---|---|
| **Status** | Phase 1 implementation started – Rust core, CLI, WASM and add-in skeleton built; not yet tested inside Outlook |
| **Target platform** | Windows (classic + new Outlook) first; macOS as a later goal |
| **Phase 1 environment** | Consumer Microsoft 365 / Outlook.com mailboxes, no admin, no mail gateways |
| **Last updated** | 2026-11-10 |

---

## 1. Purpose

An Outlook add-in that lets a user send a short code or message, encrypted and hidden inside a signature image (the sender's name rendered in a cursive font), and that detects and reveals such hidden messages in received mail.

## 2. Requirements

### Functional
- **F1 – Send:** From the compose window, via a ribbon command (similar in feel to *Attach File*), the user enters a short code/message. The add-in renders the user's name (e.g. "Tim Furnell") as a cursive graphic, encrypts the message, embeds it in that image and inserts the image into the email as the signature.
- **F2 – Detect:** For received mail, the add-in checks signature images for the payload pattern.
- **F3 – Reveal:** If a payload is found, it is extracted and decrypted, and the user is told an embedded message is present and can view it.
- **F4 – Clean replies:** When the signature is added to a reply/forward, previous signature images in the thread are removed (unless this proves complex).

### Non-functional
- **N1:** Windows only for v1; prefer choices that keep a path to macOS.
- **N2:** Works in the *new* Outlook for Windows (COM/VSTO not supported there) and classic Outlook.
- **N3:** Payload must survive normal email transport (no lossy re-encoding of the carrier image).
- **N4:** Confidentiality comes from encryption; steganography only provides concealment.
- **N5:** No visible markers (e.g. custom headers) that reveal a payload is present. A recognisable image filename is acceptable.
- **N6:** Phase 1 must work without a Microsoft 365 admin, on consumer accounts.

## 3. Platform options considered

| Option | Summary | New Outlook | Mac | Auto-detect on receive |
|---|---|---|---|---|
| A. VSTO/COM add-in (C#) | Full control, true pop-ups | ❌ | ❌ | ✅ |
| **B. Office web add-in (Office.js)** | One codebase across clients | ✅ | ✅ | Pinned task pane (phase 1); preview events need admin |
| C. Hybrid (B + thin VSTO for auto-scan) | Bridges the auto-detect gap | ✅ | ✅ (partial) | ✅ classic |
| D. Server-side (Graph / mail flow) | Client-agnostic detection | ✅ | ✅ | ✅ (server holds keys) |

See decision **D-001**.

## 4. Architecture (phase 1)

```
┌──────────────────────── Outlook web add-in (XML manifest) ────────────────────────┐
│  TypeScript shell (Office.js)                                                      │
│   • Compose ribbon command → "Add secure signature" dialog/pane                    │
│       - get display name (userProfile.displayName, overridable in settings)        │
│       - remove existing sig_*.png inline attachments + their <img> tags (F4)       │
│       - call core → PNG bytes → addFileAttachmentFromBase64Async(isInline)         │
│       - insert <img src="cid:sig_<name>.png"> at end of body                       │
│   • Read task pane (pinnable) → on open and on ItemChanged:                        │
│       - list inline image attachments → getAttachmentContentAsync                  │
│       - call core.extract() on each candidate → show result                        │
│       - item.notificationMessages info bar: "Embedded message present"             │
│   • Settings: shared key, display name override (roamingSettings)                  │
│                         │  (thin, typed bindings via wasm-bindgen)                 │
│                         ▼                                                          │
│  stego-core (Rust → WebAssembly)                                                   │
│   • Signature renderer: name → cursive glyphs → anti-aliased PNG                   │
│     (bundled OFL font; fontdue/ab_glyph + tiny-skia)                               │
│   • Payload format + AES-256-GCM (RustCrypto)                                      │
│   • PNG encode/decode + LSB embed/extract with redundancy (`png` crate)            │
└────────────────────────────────────────────────────────────────────────────────────┘
      stego-cli (Rust, native) – same core: test vectors, debugging, batch checks
```

### Why no event-based activation in phase 1
Event-based add-ins (including the preview read-mode events) **only work when deployed by an administrator**. Phase 1 assumes no admin (N6), so automatic detection uses a **pinned task pane** that re-runs on every selected message (`ItemChanged`). The user pins it once; after that, detection is effectively automatic while the pane is open. A side effect is that everything runs in the **browser runtime**, so the main Rust/WASM risk (the JavaScript-only event runtime in classic Outlook) does not apply in phase 1.

### Installation (phase 1)
Personal/consumer accounts can self-install: Outlook → *Get Add-ins* → *My add-ins* → *Custom add-ins* → *Add a custom add-in* → *Add from file* (XML manifest).

### Hosting (phase 1) – D-011, D-016
- The WordPress site is self-hosted on a **Raspberry Pi 5**, exposed through **Cloudflare**; full server access is available.
- Built static files (HTML/JS/WASM/icons) are deployed to a static sub-folder, e.g. `https://itmsolutions.co.uk/outlook-stego/`, **directly on the file system (rsync/SFTP), not via the WordPress media library** (which renames and processes files).
- WordPress's standard rewrite rules pass through requests for real files, so the folder is served directly.
- Web server: **nginx** (D-019). The maintained config is **`deploy/nginx/outlook-stego.conf`** – a `location ^~ /outlook-stego/` block included in the WordPress server block above the PHP handler. Key points:
  - `^~` stops WordPress's PHP/rewrite rules matching this path; files are served from `/var/www/outlook-stego/` via `alias`.
  - Cache: content-hashed `*.xxxxxxxx.js|wasm` → 1 year immutable; `.html`/`.xml` → `no-cache`; css/icons → 1 hour.
  - `.wasm` → `application/wasm`: check `grep wasm /etc/nginx/mime.types`; if missing add `application/wasm wasm;` to `mime.types` (not a `types {}` block inside the location, which replaces the whole MIME map).
  - **No `X-Frame-Options` / restrictive `frame-ancestors`** on this path – Outlook iframes the task pane. The `add_header` lines in the block replace inherited server-level headers. Verify with `curl -I`.
- Cloudflare settings for the `/outlook-stego/*` path (Configuration Rule):
  - **No bot challenges / "Under Attack" / Cloudflare Access** – Outlook loads the files from an embedded webview and cannot solve challenges.
  - **Rocket Loader and any JS/HTML rewriting off** – they can break Office.js loading.
  - Caching: long cache for content-hashed filenames; short/no cache for `index.html`, `commands.html` and the manifest. Purge the Cloudflare cache on each deploy (deploy script, via Cloudflare API).
- The manifest's `SourceLocation`, icon URLs and `AppDomains` point at this folder; HTTPS with a valid certificate is required.
- The GitHub repo stays **private**. The hosted bundle is inevitably public, which is fine because it contains no secrets (the key is never in the code). A deploy script (`npm run deploy`) can push the `dist/` folder by SFTP later.

## 5. Payload, carrier & signature design

### Signature image
- Text: user's display name (e.g. "Tim Furnell"), overridable in settings.
- Font: **Allura** (SIL Open Font License – free to bundle and redistribute) embedded in the core (D-013). Font is swappable later.
- Rendering in Rust, so output is identical on every platform and no browser canvas is needed.
- Rendered at 2× size and displayed at 1× via `width`/`height` attributes for sharpness on high-DPI screens.
- **Opaque** background (white) for phase 1: LSB data in fully transparent pixels risks being zeroed by encoders, and an opaque image is easier to keep intact. Revisit transparency/dark-mode appearance later.
- Capacity: e.g. 600×150 px ≈ 90k pixels ≈ 33 KB at 1 bit per RGB channel, far more than a short code needs, so the payload can be repeated (e.g. 3× with majority vote) for robustness.

### Carrier & filename
- PNG only (lossless). Never JPEG.
- Filename hint: `sig_<name>.png` (e.g. `sig_timfurnell.png`) – no custom headers (N5).
- **Risk:** some Outlook clients may rename inline images on send (e.g. `image001.png`). The detector therefore treats the filename as a *fast path* and falls back to trying every inline PNG within a size range. Decoding a small PNG is cheap. Verified in spike S-2.

### Payload format (draft, fixed size)
`magic(4) | version(1) | flags(1) | nonce(12) | ciphertext(130) | tag(16)` = **164 bytes**, always.
- Plaintext slot = `length(2) | message(≤128 bytes UTF-8) | zero padding` – every image carries the same-size payload, so nothing about message length leaks (D-014).
- Detection = magic matches **and** the AES-GCM tag verifies, so false positives are effectively impossible.
- Embedding: LSB of RGB channels in a keyed pseudo-random pixel order (derived from the key), with the 164-byte payload repeated 3× (majority vote) ≈ 4 KB of bits – about 12% of a 600×150 image's capacity.

### Message length cap – D-014
- **Max 128 bytes** (UTF-8) – ample for passwords, PINs and shared codes; non-ASCII characters use 2–4 bytes each.
- The cap is **not** set by image capacity (a 600×150 image could carry ~30 KB). It is set by **covertness**: the more pixels altered, the easier statistical steganalysis becomes, especially on the flat white background around the lettering. A small fixed payload with redundancy changes few pixels and is robust.
- The send dialog shows a live byte counter and blocks over-length input.

### Crypto & key (phase 1)
- AES-256-GCM, one **shared passphrase** for all users (D-005, D-012).
- The passphrase/key is **never compiled into the add-in** – the hosted JS/WASM is publicly downloadable.
- Key derivation: `master_key = Argon2id(passphrase, salt = fixed app-specific constant)`, computed **once** when the user enters the passphrase in Settings (≈0.5–1 s; parameters e.g. 64 MiB memory, 3 passes). A fixed salt is needed so every user derives the same key from the same passphrase.
- Only the derived `master_key` is stored (Office `roamingSettings` – kept in the user's mailbox, synced across devices); the passphrase itself is not stored.
- Separate sub-keys via HKDF: one for AES-GCM, one for the pseudo-random pixel order.
- Passphrase guidance: at least 4–5 random words (e.g. Diceware-style); the settings page shows a strength hint. Distribute out-of-band (in person, phone, password manager share).

### Revealing a secret – D-017
- When a payload is found, an info bar on the message reads e.g. *"This message contains an embedded secret."* The secret itself is **never** shown in the info bar.
- The task pane shows the secret **masked** (`••••••`) with a **Show secret** button and a **Copy** button. Revealed text auto-hides again after ~30 s or when the user switches message.
- Copy uses `navigator.clipboard.writeText`, with a fallback (hidden text field + `execCommand('copy')`) because clipboard permissions can be restricted inside Outlook's add-in frame – verify per client in S-4.
- Decrypted secrets are kept only in memory, never written to settings or logs.

### Replies & forwards (F4)
- No admin means no `OnNewMessageCompose` event, so stripping happens **when the user clicks the ribbon command** on a reply/forward: remove inline attachments matching `sig_*.png` and their `<img>` tags, then insert the new signature.
- If the user replies without clicking, older images remain; the reader then decodes all of them and shows the newest first.
- Rewriting body HTML may disturb formatting in some clients; if so, fall back to removing attachments only.

## 6. Mobile-readiness principles (D-018)

Mobile is out of scope for phase 1 but **must not be blocked**. On mobile, sending and receiving may work differently (e.g. read-only detection via a message button + Microsoft Graph; sending via a companion page or app that produces the image to attach). To avoid re-architecture:

1. **Pure, transport-agnostic core.** `stego-core` takes bytes in and gives bytes out (render, embed, extract, encrypt, decrypt). It has no dependency on Office.js, the DOM or the network, so it can be reused in WASM (any add-in host), a Graph-based path, or a native iOS/Android app (Rust compiles to both, e.g. via UniFFI).
2. **Mail-access adapter layer** in TypeScript: an interface such as `getCandidateImages()`, `insertSignature()`, `removeOldSignatures()`, `notify()`. Phase 1 implements `OfficeJsAdapter`; a later `GraphAdapter` (nested app authentication + Graph attachment fetch) can be added without touching the UI or core.
3. **Detection must not depend on the pinned task pane alone.** Also provide a "Check message" read-mode command button; mobile surfaces only expose buttons, not pinning.
4. **Detection scans regular attachments as well as inline images**, and never relies on the filename (the filename is only a fast path). A mobile send flow may only be able to *attach* the image.
5. **Versioned, self-describing payload format** (version byte + flags), so a different send path can still produce compatible images.
6. **Keep the XML (add-in only) manifest** (unified manifest isn't supported on mobile), and keep room to add a `MobileFormFactor` section later.
7. **Settings in `roamingSettings`** (available on mobile), not browser `localStorage` or cookies.
8. **Responsive task pane UI** (works at phone widths) and a small bundle (watch WASM size: release build, `opt-level = "z"`, `wasm-opt`).
9. Avoid relying on APIs with no mobile equivalent for *core* flows (e.g. `displayDialogAsync`); use them only as optional extras.

## 7. Decision log

| ID | Date | Decision | Status | Rationale |
|---|---|---|---|---|
| D-001 | 2026-11-10 | Build as an **Office web add-in** (Option B) | Accepted | Only model supported in new Outlook for Windows; same codebase runs on Mac and web. Classic-only VSTO would need a rewrite before classic Outlook is retired (supported until at least 2029). |
| D-002 | 2026-11-10 | **TypeScript** for the add-in shell | Accepted | Office.js is a JavaScript API; no alternative for the host-facing layer. |
| D-003 | 2026-11-10 | **Rust → WebAssembly** for the core (renderer, payload format, crypto, steganography) | Accepted for phase 1 | Owner preference for Rust's safety; phase 1 runs only in browser runtimes where WASM is supported (D-007), removing the main risk. Revisit if phase 2 adds classic-Outlook event handlers (JavaScript-only runtime; `wasm2js` fallback). |
| D-004 | 2026-11-10 | Carrier image format: **PNG** | Accepted | Lossless; LSB data survives only without recompression. |
| D-005 | 2026-11-10 | **Single shared key** for phase 1, entered by each user, stored in roamingSettings | Accepted | Owner decision; simplest key management. Per-user keys deferred. |
| D-006 | 2026-11-10 | **No custom header**; detection hint is the image filename `sig_<name>.png`, with fallback to scanning all inline PNGs | Accepted | Keeps messages unmarked (N5); fallback covers clients that rename inline images. |
| D-007 | 2026-11-10 | **No event-based activation in phase 1**; detection via pinnable read task pane + `ItemChanged`, notification via info bar | Accepted | Event-based activation requires admin deployment; phase 1 assumes consumer accounts with no admin. |
| D-008 | 2026-11-10 | Phase 1 targets **consumer Microsoft 365 / Outlook.com**, self-installed from an **XML (add-in only) manifest** | Accepted | No admin available; personal accounts support *Add a custom add-in → Add from file*. |
| D-009 | 2026-11-10 | Signature image = **display name rendered in a cursive font**, generated in the Rust core | Accepted | Owner preference; natural-looking carrier; rendering in Rust keeps output identical across platforms. |
| D-010 | 2026-11-10 | **Strip previous signature images** on reply/forward when the ribbon command is used | Accepted (subject to complexity check) | Owner preference; low complexity when done on the button click. Automatic stripping would need admin-deployed events. |
| D-011 | 2026-11-10 | Host add-in files on the **existing WordPress site (itmsolutions.co.uk)** in a static sub-folder; GitHub repo stays **private** | Accepted | Existing HTTPS host; no secrets in the hosted bundle, so public hosting of built files is acceptable. |
| D-012 | 2026-11-10 | Shared secret is a **passphrase**, stretched with **Argon2id** (fixed app salt) + HKDF sub-keys; only the derived key is stored | Accepted | Easier to communicate and manage than a raw key; Argon2id slows brute-forcing. |
| D-013 | 2026-11-10 | Signature font: **Allura** (SIL OFL) | Accepted | Owner choice; OFL permits embedding in the add-in. |
| D-014 | 2026-11-10 | Message cap **128 bytes**, fixed-size padded payload | Accepted | Use case is passwords/codes; small fixed payload minimises detectable changes and hides message length. |
| D-015 | 2026-11-10 | **Mobile parked** for a later phase (send/receive may work differently there); keep XML manifest | Accepted | Outlook mobile add-ins can't activate in compose mode (except admin-deployed events) and can't read attachment content via Office.js; a Graph + nested app authentication path needs a spike. |
| D-016 | 2026-11-10 | Hosting details: WordPress on **Raspberry Pi 5 behind Cloudflare**; static sub-folder deployed by rsync/SFTP; Cloudflare challenges and JS rewriting disabled for that path; cache purge on deploy | Accepted | Full server access available; Outlook's webview can't pass bot challenges. |
| D-017 | 2026-11-10 | Reveal UX: info bar notice only; secret **masked** in task pane with **Show secret** + **Copy**; auto-hide; memory-only | Accepted | Owner preference; avoids secrets being visible by default or persisted. |
| D-018 | 2026-11-10 | **Mobile-readiness principles** (section 6) are mandatory design constraints | Accepted | Owner requirement: no phase 1 decision may block mobile or force re-architecture. |
| D-019 | 2026-11-10 | Serve add-in files via a dedicated **nginx `location ^~ /outlook-stego/`** block (static only, cache headers, no frame-blocking headers) | Accepted | Pi runs nginx; keeps the add-in isolated from WordPress/PHP and allows Outlook to iframe the pane. |
| D-020 | 2026-11-10 | Both ribbon buttons open the **task pane** (read: *Check message*, pinnable; compose: *Secure signature*). Signature placed with `setSignatureAsync` (Mailbox 1.10) when available, otherwise at the cursor. Manifest minimum **Mailbox 1.8** | Accepted | Compose needs input (the secret); `setSignatureAsync` puts the image above quoted text on replies; 1.8 provides attachment read/insert APIs. |
| D-021 | 2026-11-10 | Core crypto/image crates: RustCrypto `aes-gcm 0.10` (no default features – no RNG in core), `argon2 0.5`, `hkdf 0.12`, `png 0.17`, `ab_glyph 0.2`, `rand_chacha 0.3` | Accepted | Mature, stable APIs; core stays RNG-free (nonce supplied by caller). Newer major versions exist – upgrade deliberately, re-running the pixel-order fingerprint test. |
| D-022 | 2026-11-10 | Pixel order spec: ChaCha20 (seed = HKDF pixel key), `slot = next_u64() % slots`, skip duplicates; copy *r* of bit *i* at position `r·1312 + i`; images need ≥ 2× the 3,936 slots required | Accepted | Simple, deterministic across native and WASM (verified: images cross-decode); a unit test pins the sequence so it can't silently change. |
| D-023 | 2026-11-10 | Settings show a **Key ID** (first 4 bytes of SHA-256 of the derived key, e.g. `3F9A-12C0`) | Accepted | Lets users confirm they share the same passphrase without revealing it. |

## 8. Open questions

Resolved: ~~Q-1 key management~~ (D-005) · ~~Q-2 covertness~~ (D-006) · ~~Q-3 mail path~~ (pure Office 365, no gateways) · ~~Q-4 replies~~ (D-010) · ~~Q-5 deployment~~ (D-007, D-008) · ~~Q-6 signature~~ (D-009) · ~~Q-7 hosting~~ (D-011) · ~~Q-8 key format~~ (D-012) · ~~Q-9 font~~ (D-013) · ~~Q-10 length~~ (D-014) · ~~Q-11 mobile~~ (D-015) · ~~Q-12 hosting access~~ (D-016) · ~~Q-13 reveal UX~~ (D-017) · ~~Q-14 mobile~~ (D-015, D-018)

_No open questions at present._ (~~Q-15 web server~~ → D-019)

## 9. Implementation status (2026-11-10)

**Done**
- `stego-core`: payload v1 (magic `OSTG`, 164 bytes), Argon2id (64 MiB, t=3, p=1) + HKDF, AES-256-GCM, Allura renderer (160 px at 2×, ~572×137 for "Tim Furnell"), keyed LSB embedding with 3× repetition and majority vote, RGB/RGBA PNG decode. 16 unit tests.
- Cross-check: images created by WASM decode in the native CLI and vice versa; wrong passphrase and plain images find nothing. Embedding changes ~2,000 channel values by ±1 (invisible).
- `stego-cli` (`stego create|extract|render|derive-key`).
- `stego-wasm` (587 KiB incl. ~240 KiB font; key derivation ≈ 0.3 s).
- Add-in: XML manifest (passes `office-addin-manifest validate`), webpack build, `MailAdapter` + `OfficeJsAdapter`, task pane (settings / compose / read with masked reveal, copy, 30 s auto-hide), icons, nginx config, deploy script (scp + Cloudflare purge).

![Sample signature with embedded secret](images/sample-signature.png)

**Next**
1. Sideload the dev build into Outlook.com (new Outlook, classic, web) – S-1.
2. Transport tests – S-2 (byte-identical? filename preserved? reply/forward behaviour of `setSignatureAsync` and image stripping).
3. Hosting check on the Pi – S-5.

**Follow-ups / tech debt**
- Subset the Allura font to Latin glyphs to cut ~150–200 KiB from the WASM.
- Run Argon2id in a Web Worker so the UI doesn't freeze during key derivation.
- TypeScript unit tests (adapter mocked) and an automated round-trip test in CI.
- Body-order detection of "newest" signature in long threads (currently attachment order, hinted names first).

## 10. Spikes / next steps

- **S-1 Skeleton:** scaffold the add-in (Yeoman `yo office`, XML manifest). Ribbon button inserts a static inline PNG; read pane lists inline attachments. Sideload to an Outlook.com account.
- **S-2 Transport spike:** send a test PNG between Outlook.com/M365 accounts using new Outlook, classic Outlook and Outlook on the web. Verify (a) the bytes are unchanged, (b) whether the filename is preserved, (c) behaviour on reply/forward.
- ~~**S-3 Rust core:**~~ _done_ – workspace with `stego-core` (+ wasm-bindgen) and `stego-cli`; render name → PNG; embed/extract round-trip; test vectors.
- **S-4 Integration:** wire WASM into the compose command and the read pane; settings page for the key.
- **S-5 Hosting check:** deploy a "hello world" task pane + `.wasm` file to `itmsolutions.co.uk/outlook-stego/`; confirm HTTPS, MIME type, that WordPress doesn't intercept the requests, and that Cloudflare serves it to Outlook (new, classic, web) without challenges. Check headers with `curl -I https://itmsolutions.co.uk/outlook-stego/taskpane.html` (no `X-Frame-Options`) and `.../core_bg.wasm` (`Content-Type: application/wasm`).
- **Phase 2 candidates:** per-user keys, admin-deployed event-based detection, Mac validation, transparent/dark-mode-friendly signature, mobile read-only detection (spike: nested app authentication + Graph attachment fetch on iOS/Android with a personal account).
