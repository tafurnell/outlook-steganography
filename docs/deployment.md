# Deployment runbook – Secure Signature Outlook add-in

How to set up hosting once, release new versions, and install the add-in in Outlook.
Decisions behind these steps are in [design-and-decisions.md](design-and-decisions.md) (D-011, D-016, D-019, D-033, D-034, D-041).

| | |
|---|---|
| **Public URL** | `https://itmsolutions.co.uk/outlook-stego/` |
| **Server** | Raspberry Pi 5, nginx 1.22, WordPress site, files in `/var/www/outlook-stego/` |
| **CDN** | Cloudflare (Free plan) in front of the Pi |
| **Build machine** | Windows (Rust + Node.js) |
| **Add-ins** | Production **Secure Signature** (ID `70da7104-…`, served from the Pi) · Dev **Secure Signature (dev)** (ID `fe2ac711-…`, served from `https://localhost:3000`) – both can be installed side by side |

---

## 1. One-time setup

### 1.1 Windows build machine

1. **Rust** via <https://rustup.rs> – accept the *Visual Studio Build Tools (Desktop development with C++)* it offers.
2. WebAssembly target and bindings generator (the version **must match** `wasm-bindgen` in `Cargo.lock`):
   ```powershell
   rustup target add wasm32-unknown-unknown
   cargo install wasm-bindgen-cli --version 0.2.130
   ```
3. **Node.js 20+**, then the WASM size optimiser:
   ```powershell
   npm i -g binaryen
   ```
4. Add-in dependencies:
   ```powershell
   cd addin
   npm install
   npm approve-scripts esbuild     # if npm warns about allowScripts (used by the test runner)
   ```
5. SSH access to the Pi from this PC (OpenSSH is built into Windows 10+). Check:
   ```powershell
   ssh <user>@<pi-lan-ip> "ls -ld /var/www/outlook-stego"
   ```
   Use the Pi's **LAN address or local hostname** – not `itmsolutions.co.uk`, which goes through Cloudflare (web traffic only). Optional: set up SSH keys to avoid password prompts.

### 1.2 Raspberry Pi (nginx)

```bash
# Folder for the add-in, owned by the deploy user
sudo mkdir -p /var/www/outlook-stego
sudo chown "$USER":www-data /var/www/outlook-stego
sudo chmod 755 /var/www/outlook-stego

# nginx location block (copy deploy/nginx/outlook-stego.conf from the repo to the Pi first)
sudo cp outlook-stego.conf /etc/nginx/snippets/outlook-stego.conf
```

In the WordPress **HTTPS** `server { … }` block, **above** the `location ~ \.php$` block, add:

```nginx
include snippets/outlook-stego.conf;
```

Then:

```bash
grep -q wasm /etc/nginx/mime.types || echo "add 'application/wasm wasm;' to /etc/nginx/mime.types"
sudo nginx -t && sudo systemctl reload nginx
```

What the snippet does (see the comments in the file):
- `location ^~ /outlook-stego/` – served straight from disk; WordPress/PHP never sees these requests.
- Hashed files (`*.xxxxxxxx.js|wasm`) – cached for a year (`immutable`). The regex is **quoted** because it contains `{8}`.
- `*.html`, `*.xml`, `launchevent.js` – `no-cache`, so a deploy takes effect immediately.
- css / icons – 1 hour.
- No `X-Frame-Options` on this path (Outlook shows the pane in a frame); the block's `add_header` lines replace any server-level ones.

**Whenever `deploy/nginx/outlook-stego.conf` changes in the repo**, copy it to the Pi again and `sudo nginx -t && sudo systemctl reload nginx`.

### 1.3 Cloudflare

| Setting | Where | Value | Needed? |
|---|---|---|---|
| **Cache Rule – event script** | Caching → Cache Rules → Create rule | Name `Outlook add-in event script`; *URI Path* **equals** `/outlook-stego/launchevent.js`; Cache eligibility **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin TTL** | **Yes** – otherwise Cloudflare's default 4-hour browser TTL replaces nginx's `no-cache` on this `.js` file and Outlook can run a stale event script for hours after a release |
| Configuration Rule | Rules → Overview → Create rule → Configuration Rule | *URI Path* starts with `/outlook-stego/` → Security Level *Essentially Off*, Browser Integrity Check *Off*, Rocket Loader *Off* | Only if `npm run verify` reports a challenge page or rewritten scripts (not needed so far) |
| Bot Fight Mode | Security → Bots | Off | Only if it causes challenges (zone-wide on Free) |
| API token (optional) | My Profile → API Tokens → Create Token | *Zone → Cache Purge → Purge* for this zone; note the **Zone ID** from the zone Overview | Lets `npm run deploy` purge Cloudflare automatically |

Don't change the zone-wide *Browser Cache TTL* to "Respect existing headers" – that would also affect the WordPress site's scripts.

---

## 2. Releasing a new version

From the repo on Windows:

```powershell
cd addin
npm run build        # Rust → WASM (wasm-opt), then the production add-in into addin\dist
npm test             # rebuilds WASM if needed, then all Vitest tests
npm run deploy       # scp to the Pi, chmod -R a+rX, Cloudflare purge (if token set)
npm run verify       # checks the live site – must end with "All checks passed"
```

Environment variables for `deploy` (set once per PowerShell session, or in your profile):

```powershell
$env:DEPLOY_TARGET = "<user>@<pi-lan-ip>:/var/www/outlook-stego/"
$env:CF_API_TOKEN  = "<token>"     # optional – automatic purge
$env:CF_ZONE_ID    = "<zone id>"   # optional – automatic purge
```

Without the Cloudflare token, purge manually after deploying: Caching → Configuration → Purge Cache → **Custom Purge** with the stable-named URLs (`taskpane.html`, `commands.html`, `manifest.xml`, `taskpane.css`, `launchevent.js`, `assets/icon-*.png` under `https://itmsolutions.co.uk/outlook-stego/`). Hashed files never need purging.

Then:

1. **Commit and push** – GitHub Actions (`.github/workflows/ci.yml`) re-runs Rust tests, Clippy, the build, typecheck and tests, and keeps the built `dist` as an artifact. Check the **Actions** tab is green.
2. **In Outlook**: close and reopen the pane to load the new version.
3. **Reinstall the add-in only if the manifest changed** (see 3.2).

### What `npm run verify` checks

For `taskpane.html`, `commands.html`, `manifest.xml`, the hashed bundle, the `.wasm` file, `launchevent.js` and an icon: HTTP 200, correct `Content-Type` (incl. `application/wasm`), no `X-Frame-Options` / CSP `frame-ancestors`, the expected `Cache-Control`, no Cloudflare challenge page, the manifest points at this URL and enables compose events, and the `.wasm` file is valid WebAssembly.

---

## 3. Installing in Outlook

### 3.1 First install (production)

1. Use the file built locally: `addin\dist\manifest.xml` – or download it **without a browser** (browser extensions such as dark-mode tools can alter a page saved with "Save as"):
   ```powershell
   Invoke-WebRequest https://itmsolutions.co.uk/outlook-stego/manifest.xml -OutFile manifest.xml
   ```
2. Outlook (new Outlook, classic Outlook or Outlook on the web): **Get Add-ins → My add-ins → Custom add-ins → Add a custom add-in → Add from file…** (Outlook on the web shortcut: <https://aka.ms/olksideload>).
3. Open the add-in (**Apps** / **…** menu → *Secure Signature*) → **Settings** → enter the shared passphrase → **Save**. Compare the **Key ID** with your contacts'.

### 3.2 When to reinstall

Outlook reads the manifest **only at install time**. Reinstall (remove *Secure Signature* under *Custom add-ins*, then *Add from file*) when `addin/manifest.template.xml` or the manifest parts of `addin/webpack.config.js` changed – e.g. new buttons, events, requirement sets, URLs. Code-only changes need just a deploy and reopening the pane. Roaming settings (passphrase-derived key, options) are kept per add-in ID; check the Key ID after reinstalling and re-enter the passphrase if needed.

---

## 4. Development workflow

```powershell
cd addin
npm run build:wasm   # after any Rust change (npm test also does this)
npm run dev          # https://localhost:3000 – trusted dev certificate on first run
Invoke-WebRequest https://localhost:3000/manifest.xml -OutFile manifest-dev.xml
```

Install `manifest-dev.xml` as above – it appears as **Secure Signature (dev)** and has its own settings. Restart `npm run dev` after changing `webpack.config.js`. The dev server sends `no-store`, so reopening the pane always loads the latest code.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `verify`: HTTP 403 on `assets/…` | `scp` from Windows created folders nginx can't read | `sudo chmod -R a+rX /var/www/outlook-stego` (deploy now does this automatically) |
| `verify`: `Cache-Control "max-age=14400"` on `launchevent.js` | Cloudflare's default Browser TTL overrides `no-cache` for `.js` | Add the Cache Rule in 1.3, then purge the file |
| `verify`: page looks like WordPress / 404 from WordPress | nginx `include` missing, below the PHP location, or in the wrong `server` block | `sudo nginx -T \| grep -n outlook-stego` – the include must be in the HTTPS server block that serves the site |
| `nginx -t` fails in the snippet | Unquoted regex containing `{ }` | Use the repo version of the snippet (regex is quoted) |
| Pane blank in Outlook | Frame-blocking header, or a script failed to load | `verify`; in Outlook on the web press F12 → Console |
| "The manifest file doesn't conform to the schema… 'nighteye' attribute" | Manifest saved from a browser with an extension that injects attributes | Download with `Invoke-WebRequest` or use `addin\dist\manifest.xml` |
| Old behaviour after a release | Pane still open from before, or a stale Cloudflare copy | Close/reopen the pane; purge Cloudflare; run `verify` |
| Pane checks the wrong email | Outlook.com can't pin panes; an open pane stays on the email it was opened for | Compare the "Checked: … from … received …" line; close and reopen the pane |
| CI fails on Clippy after a Rust release | New lint in the latest stable Rust | Fix the reported line (the suggestion is in the log) and push |
| `npm test` fails on a Rust-related test | Stale WASM build | `npm test` rebuilds it automatically; otherwise `npm run build:wasm` |

---

## 6. Rollback

Every release is a commit. To roll back: `git checkout <previous-commit>`, then `npm run build`, `npm run deploy`, `npm run verify` (and reinstall in Outlook only if the manifest differs). Hashed files from newer builds left on the Pi are harmless.
