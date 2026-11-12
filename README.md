# Outlook Secure Signature (outlook-steganography)

An Outlook web add-in that hides a short encrypted code (password, PIN, shared code) inside a cursive signature image of your name, and reveals codes hidden in received messages.

Design, decisions and open questions: **[docs/design-and-decisions.md](docs/design-and-decisions.md)**.

## Repository layout

```
crates/
  stego-core/   Rust core – renderer (Allura), payload format, Argon2id/HKDF, AES-256-GCM, LSB steganography
  stego-cli/    Native CLI (`stego`) over the core – create/extract/test images
  stego-wasm/   wasm-bindgen bindings used by the add-in
addin/          Outlook web add-in (TypeScript, Office.js, webpack, XML manifest)
  src/core/     WASM loader + typed wrapper
  src/mail/     MailAdapter interface + OfficeJsAdapter (mobile GraphAdapter can be added later)
  src/taskpane/ Task pane UI (settings, compose, read)
deploy/nginx/   nginx location block for the Raspberry Pi host
scripts/        build-wasm.mjs, deploy.mjs (cross-platform Node scripts)
docs/           Design & decision log
```

## Prerequisites (Windows)

1. **Rust** via [rustup](https://rustup.rs) (plus the *Visual Studio Build Tools – Desktop development with C++* that rustup offers to install).
2. `rustup target add wasm32-unknown-unknown`
3. `cargo install wasm-bindgen-cli --version 0.2.130` – **must match** the `wasm-bindgen` version in `Cargo.lock`.
4. **Node.js 20+**.
5. `npm i -g binaryen` (provides `wasm-opt` – shrinks the WASM file; optional but recommended).

## Build & test

```powershell
cargo test --workspace            # Rust unit tests
cd addin
npm install
npm run build                     # builds WASM, then the add-in into addin/dist (production URLs)
npm run typecheck
npm test                          # Vitest: MIME parser, draft HTML editing, WASM round trip
```

GitHub Actions (`.github/workflows/ci.yml`) runs all of the above on every push and keeps the built `dist` as a downloadable artifact.

The embedded font is a Latin-only subset of Allura (`scripts/subset-font.py`). It limits only the **visible signature text** to Latin letters, digits and common punctuation; secrets are never drawn, so they can contain any characters.

### CLI

```powershell
cargo build --release -p stego-cli
$env:STEGO_PASSPHRASE = "five random words go here"
target\release\stego create --name "Tim Furnell" --message "Door code: 4711#"   # writes sig_timfurnell.png
target\release\stego extract sig_timfurnell.png
target\release\stego derive-key                                                  # prints the stored key form
```

## Try it in Outlook (development)

```powershell
cd addin
npm run build:wasm
npm run dev                       # https://localhost:3000 (installs a trusted dev certificate on first run)
```

1. Open https://localhost:3000/manifest.xml and save it.
2. In Outlook (new Outlook, classic Outlook or Outlook on the web): **Get Add-ins → My add-ins → Custom add-ins → Add a custom add-in → Add from file…**, choose the saved manifest.
   (Outlook on the web shortcut: https://aka.ms/olksideload)
3. Open the add-in → **Settings** → enter the shared passphrase. Share the displayed **Key ID** with your contacts to confirm you all use the same passphrase.
4. **Compose:** *Secure signature* button → enter the secret → *Insert signature*.
5. **Read:** *Check message* button → pin the pane to check every message.

Remove the dev add-in before installing the production one (they share the same ID).

## Deploy (production)

Full runbook – one-time Pi/nginx and Cloudflare setup, releases, installing in Outlook, troubleshooting, rollback: **[docs/deployment.md](docs/deployment.md)**.

Each release, from `addin`:

```powershell
npm run build
npm test
npm run deploy     # needs $env:DEPLOY_TARGET (and optionally CF_API_TOKEN / CF_ZONE_ID)
npm run verify     # must end with "All checks passed"
```

Reinstall the add-in in Outlook only when the manifest changed.

## Security notes

- The passphrase is never stored; only the Argon2id-derived key is kept in Outlook roaming settings (in your mailbox).
- No secrets are compiled into the add-in – the hosted files are public by design.
- Steganography conceals; AES-256-GCM protects. Anyone with the passphrase can read every hidden code.
