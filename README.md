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
5. Optional, for a smaller WASM file: `npm i -g binaryen` (provides `wasm-opt`).

## Build & test

```powershell
cargo test --workspace            # Rust unit tests
cd addin
npm install
npm run build                     # builds WASM, then the add-in into addin/dist (production URLs)
npm run typecheck
```

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

### One-time setup on the Raspberry Pi

```bash
# 1. Folder for the add-in, owned by the user you'll deploy as
sudo mkdir -p /var/www/outlook-stego
sudo chown "$USER":www-data /var/www/outlook-stego
sudo chmod 755 /var/www/outlook-stego

# 2. nginx location block (copy deploy/nginx/outlook-stego.conf to the Pi first, e.g. with scp)
sudo cp outlook-stego.conf /etc/nginx/snippets/outlook-stego.conf
#    Then add this line inside the WordPress  server { listen 443 ...  }  block,
#    ABOVE the  location ~ \.php$  block:
#        include /etc/nginx/snippets/outlook-stego.conf;
grep -q wasm /etc/nginx/mime.types || echo "add 'application/wasm wasm;' to /etc/nginx/mime.types"
sudo nginx -t && sudo systemctl reload nginx
```

If WordPress uses an nginx FastCGI/page cache with its own `location /` rules, the `^~` prefix in the snippet still takes precedence.

### One-time setup in Cloudflare (dashboard → itmsolutions.co.uk)

- **Rules → Configuration Rules → Create**: *URI Path starts with* `/outlook-stego/` → Security Level **Essentially Off**, **Rocket Loader Off**, Browser Integrity Check **Off**.
- If **Bot Fight Mode** (Security → Bots) is on, it applies zone-wide and can block Outlook's requests – check the verify step below; switch it off if challenges appear.
- Optional, for automatic cache purge on deploy: **My Profile → API Tokens → Create Token** with *Zone → Cache Purge → Purge* for this zone; note the **Zone ID** (Overview page).

### Each release (from Windows)

```powershell
cd addin
npm run build                                   # production build → addin\dist (ID + URLs for itmsolutions.co.uk)
$env:DEPLOY_TARGET = "tim@<pi-host>:/var/www/outlook-stego/"
$env:CF_API_TOKEN = "..."; $env:CF_ZONE_ID = "..."   # optional
npm run deploy                                  # scp + Cloudflare purge
npm run verify                                  # checks status codes, MIME types, headers, caching, challenges
```

Then in Outlook: **Add a custom add-in → Add from file…** with `addin\dist\manifest.xml` (or download https://itmsolutions.co.uk/outlook-stego/manifest.xml with `Invoke-WebRequest` – not a browser "Save as"). The production add-in is called **Secure Signature**; the dev one **Secure Signature (dev)** – they have different IDs, so both can be installed. Settings are stored per add-in, so enter the passphrase once in the production add-in too.

## Security notes

- The passphrase is never stored; only the Argon2id-derived key is kept in Outlook roaming settings (in your mailbox).
- No secrets are compiled into the add-in – the hosted files are public by design.
- Steganography conceals; AES-256-GCM protects. Anyone with the passphrase can read every hidden code.
