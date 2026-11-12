// Check that a deployed add-in is served the way Outlook needs it.
//   node scripts/verify-deploy.mjs [baseUrl]
// Default base: https://itmsolutions.co.uk/outlook-stego/   (exit code 1 if any check fails)
const base = (process.argv[2] || process.env.ADDIN_BASE_URL || "https://itmsolutions.co.uk/outlook-stego/").replace(/\/?$/, "/");
let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => { failures++; console.log(`  ✘ ${msg}`); };

async function get(path, { text = true } = {}) {
  const url = new URL(path, base).toString();
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (verify-deploy)" } });
  const body = text ? await res.text() : new Uint8Array(await res.arrayBuffer());
  return { url, res, body };
}

function checkCommon(name, { res, body }, { type, cache }) {
  console.log(`\n${name}  (${res.url || ""})`);
  res.status === 200 ? ok("HTTP 200") : bad(`HTTP ${res.status} – expected 200`);
  const ct = res.headers.get("content-type") || "";
  ct.includes(type) ? ok(`Content-Type ${ct}`) : bad(`Content-Type "${ct}" – expected ${type}`);
  const xfo = res.headers.get("x-frame-options");
  xfo ? bad(`X-Frame-Options: ${xfo} – Outlook can't load the pane in a frame`) : ok("no X-Frame-Options");
  const csp = res.headers.get("content-security-policy") || "";
  /frame-ancestors/i.test(csp) ? bad(`CSP frame-ancestors present: ${csp}`) : ok("no CSP frame-ancestors");
  if (res.headers.get("cf-mitigated") || (typeof body === "string" && /Just a moment|cf-challenge|challenge-platform/i.test(body))) {
    bad("Cloudflare challenge page served – disable challenges for this path");
  }
  const cc = res.headers.get("cache-control") || "(none)";
  cache.test(cc) ? ok(`Cache-Control ${cc}`) : bad(`Cache-Control "${cc}" – expected ${cache}`);
}

console.log(`Verifying ${base}`);
try {
  const pane = await get("taskpane.html");
  checkCommon("taskpane.html", pane, { type: "text/html", cache: /no-cache|no-store|max-age=0/ });
  if (/<\?php|wp-content|wp-json/i.test(pane.body)) bad("looks like a WordPress page – the nginx location block isn't matching");

  const cmds = await get("commands.html");
  checkCommon("commands.html", cmds, { type: "text/html", cache: /no-cache|no-store|max-age=0/ });

  const manifest = await get("manifest.xml");
  checkCommon("manifest.xml", manifest, { type: "xml", cache: /no-cache|no-store|max-age=0/ });
  manifest.body.includes(`${base}taskpane.html`) ? ok("manifest points at this base URL") : bad("manifest URLs don't match this base – was it built with the right ADDIN_BASE_URL?");

  const js = pane.body.match(/taskpane\.[0-9a-f]{8}\.js/)?.[0];
  if (!js) bad("couldn't find taskpane.<hash>.js in taskpane.html");
  else {
    const bundle = await get(js);
    checkCommon(js, bundle, { type: "javascript", cache: /immutable|max-age=31536000/ });
    const wasm = bundle.body.match(/stego_wasm_bg\.[0-9a-f]{8}\.wasm/)?.[0];
    if (!wasm) bad("couldn't find the .wasm file name in the bundle");
    else {
      const w = await get(`assets/${wasm}`, { text: false });
      checkCommon(`assets/${wasm}`, w, { type: "application/wasm", cache: /immutable|max-age=31536000/ });
      const magic = w.body.slice(0, 4);
      magic[0] === 0 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d ? ok(`valid WebAssembly (${Math.round(w.body.length / 1024)} KiB)`) : bad("not a WebAssembly file");
    }
  }

  const ev = await get("launchevent.js");
  checkCommon("launchevent.js", ev, { type: "javascript", cache: /no-cache|no-store|max-age=0/ });
  /onNewMessageComposeHandler/.test(ev.body) ? ok("event handler present") : bad("launchevent.js doesn't register onNewMessageComposeHandler");
  /LaunchEvent/.test(manifest.body) ? ok("manifest enables compose events") : bad("manifest has no LaunchEvent – built with ENABLE_EVENTS=0?");

  const icon = await get("assets/icon-32.png", { text: false });
  console.log("\nassets/icon-32.png");
  icon.res.status === 200 ? ok("HTTP 200") : bad(`HTTP ${icon.res.status}`);
} catch (e) {
  bad(`request failed: ${e.message}`);
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll checks passed – install manifest.xml in Outlook.");
process.exit(failures ? 1 : 0);
