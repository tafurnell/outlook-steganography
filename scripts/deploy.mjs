// Deploy addin/dist to the Raspberry Pi web server and purge Cloudflare's cache.
//
// Environment:
//   DEPLOY_TARGET   scp destination, e.g.  tim@raspberrypi.local:/var/www/outlook-stego/
//   CF_API_TOKEN    (optional) Cloudflare API token with "Cache Purge" permission
//   CF_ZONE_ID      (optional) Cloudflare zone ID for itmsolutions.co.uk
//   ADDIN_BASE_URL  (optional) public URL, default https://itmsolutions.co.uk/outlook-stego/
//
// Uses OpenSSH `scp` (built into Windows 10+, macOS and Linux).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "addin", "dist");
const target = process.env.DEPLOY_TARGET;
const base = (process.env.ADDIN_BASE_URL || "https://itmsolutions.co.uk/outlook-stego/").replace(/\/?$/, "/");
if (!target) {
  console.error("Set DEPLOY_TARGET, e.g. tim@raspberrypi.local:/var/www/outlook-stego/");
  process.exit(1);
}

const entries = readdirSync(dist).map((f) => join(dist, f));
execFileSync("scp", ["-r", ...entries, target], { stdio: "inherit" });
console.log(`Uploaded ${entries.length} entries to ${target}`);

const { CF_API_TOKEN: token, CF_ZONE_ID: zone } = process.env;
if (token && zone) {
  // Hashed files never need purging; purge the stable-named ones.
  const stable = ["taskpane.html", "commands.html", "manifest.xml", "taskpane.css",
    ...[16, 32, 64, 80, 128].map((s) => `assets/icon-${s}.png`)];
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files: stable.map((f) => base + f) }),
  });
  const body = await res.json();
  console.log(body.success ? "Cloudflare cache purged." : `Cloudflare purge failed: ${JSON.stringify(body.errors)}`);
} else {
  console.log("CF_API_TOKEN/CF_ZONE_ID not set – skipping Cloudflare purge.");
}
