import {
  createSignature, deriveMasterKey, extractMessage, keyFingerprint, loadCore, maxMessageBytes, utf8Length,
} from "../core/stego";
import type { MailAdapter } from "../mail/MailAdapter";
import { OfficeJsAdapter } from "../mail/OfficeJsAdapter";

const KEY_SETTING = "ostg.masterKey";
const NAME_SETTING = "ostg.displayName";
const REVEAL_MS = 30_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let mail: MailAdapter;
let scanGeneration = 0;
let hideTimers: number[] = [];

function setStatus(text: string, error = false): void {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", error);
}

function show(view: "settings" | "compose" | "read"): void {
  $("settingsView").hidden = view !== "settings";
  $("composeView").hidden = view !== "compose";
  $("readView").hidden = view !== "read";
}

const storedKey = () => mail.settings.get(KEY_SETTING);
const displayName = () => mail.settings.get(NAME_SETTING) || mail.userDisplayName();

function mainView(): void {
  if (!storedKey()) {
    openSettings();
    setStatus("Set the shared passphrase to get started.");
    return;
  }
  if (mail.mode === "compose") {
    show("compose");
    ($("sigName") as HTMLInputElement).value = displayName();
    updateCounter();
  } else {
    show("read");
    void scan();
  }
}

/* ---------------- Settings ---------------- */

async function openSettings(): Promise<void> {
  show("settings");
  ($("displayName") as HTMLInputElement).value = displayName();
  const key = storedKey();
  $("keyInfo").textContent = key
    ? `Key set – ID ${await keyFingerprint(key)}. Compare this ID with your contacts to confirm you share the same passphrase.`
    : "No key set yet.";
}

async function saveSettings(): Promise<void> {
  const pass = ($("passphrase") as HTMLInputElement).value;
  const name = ($("displayName") as HTMLInputElement).value.trim();
  try {
    if (pass.trim()) {
      if (pass.trim().split(/\s+/).length < 4 && pass.trim().length < 20) {
        setStatus("Use a longer passphrase – at least 4 random words.", true);
        return;
      }
      setStatus("Deriving key… (takes a moment)");
      await new Promise((r) => setTimeout(r, 30)); // let the status paint before the CPU-heavy step
      await mail.settings.set(KEY_SETTING, deriveMasterKey(pass));
      ($("passphrase") as HTMLInputElement).value = "";
    }
    await mail.settings.set(NAME_SETTING, name && name !== mail.userDisplayName() ? name : undefined);
    setStatus("Settings saved.");
    mainView();
  } catch (e) {
    setStatus(`Could not save settings: ${(e as Error).message ?? e}`, true);
  }
}

async function forgetKey(): Promise<void> {
  await mail.settings.set(KEY_SETTING, undefined);
  setStatus("Key removed from this mailbox.");
  void openSettings();
}

/* ---------------- Compose ---------------- */

function updateCounter(): void {
  const n = utf8Length(($("secret") as HTMLInputElement).value);
  const max = maxMessageBytes();
  $("counter").textContent = `${n} / ${max} bytes`;
  ($("insertSig") as HTMLButtonElement).disabled = n === 0 || n > max;
}

async function insertSignature(): Promise<void> {
  const key = storedKey();
  const secretEl = $("secret") as HTMLInputElement;
  const name = ($("sigName") as HTMLInputElement).value.trim();
  if (!key) return void openSettings();
  if (!name) return setStatus("Enter the name to show in the signature.", true);
  const btn = $("insertSig") as HTMLButtonElement;
  btn.disabled = true;
  try {
    setStatus("Creating signature…");
    const removed = await mail.removeExistingSignatures();
    const sig = createSignature(key, name, secretEl.value);
    await mail.insertSignature(sig, name);
    secretEl.value = "";
    setStatus(removed ? `Signature added (replaced ${removed} previous).` : "Signature added.");
  } catch (e) {
    setStatus(`Could not add signature: ${(e as Error).message ?? e}`, true);
  } finally {
    updateCounter();
  }
}

/* ---------------- Read ---------------- */

function clearResults(): void {
  hideTimers.forEach((t) => clearTimeout(t));
  hideTimers = [];
  $("results").replaceChildren(); // drops revealed secrets from the DOM
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be blocked inside the add-in frame – legacy fallback.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function addSecretCard(secret: string, source: string): void {
  const tpl = $("secretCard") as HTMLTemplateElement;
  const card = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const code = card.querySelector(".secret") as HTMLElement;
  const showBtn = card.querySelector(".show") as HTMLButtonElement;
  (card.querySelector(".src") as HTMLElement).textContent = `(${source})`;

  const mask = () => {
    code.textContent = "••••••••";
    code.classList.add("masked");
    showBtn.textContent = "Show secret";
  };
  showBtn.addEventListener("click", () => {
    if (code.classList.contains("masked")) {
      code.textContent = secret;
      code.classList.remove("masked");
      showBtn.textContent = "Hide";
      hideTimers.push(window.setTimeout(mask, REVEAL_MS));
    } else mask();
  });
  (card.querySelector(".copy") as HTMLButtonElement).addEventListener("click", async () => {
    setStatus((await copyText(secret)) ? "Copied to clipboard." : "Copy failed – use Show secret instead.", false);
  });
  $("results").appendChild(card);
}

async function scan(): Promise<void> {
  const gen = ++scanGeneration;
  clearResults();
  const key = storedKey();
  if (!key) return;
  setStatus("Checking for hidden messages…");
  try {
    const images = await mail.listCandidateImages();
    if (gen !== scanGeneration) return; // user moved to another message
    const found: { secret: string; source: string }[] = [];
    for (const img of images) {
      const secret = extractMessage(key, img.bytes);
      if (secret !== undefined) found.push({ secret, source: img.name });
    }
    if (gen !== scanGeneration) return;
    if (found.length) {
      found.forEach((f) => addSecretCard(f.secret, f.source));
      setStatus(found.length === 1 ? "This message contains an embedded secret." : `${found.length} embedded secrets found (newest first if the thread was replied to).`);
      await mail.notify("This message contains an embedded secret. Open Secure Signature to view it.");
    } else {
      setStatus(images.length ? "No hidden message in this email." : "No signature images in this email.");
      await mail.clearNotification();
    }
  } catch (e) {
    if (gen === scanGeneration) setStatus(`Check failed: ${(e as Error).message ?? e}`, true);
  }
}

/* ---------------- Boot ---------------- */

Office.onReady(async () => {
  mail = new OfficeJsAdapter();
  try {
    await loadCore();
  } catch (e) {
    setStatus(`Failed to load the crypto module: ${(e as Error).message ?? e}`, true);
    return;
  }

  $("settingsToggle").addEventListener("click", () => ($("settingsView").hidden ? openSettings() : mainView()));
  $("saveSettings").addEventListener("click", saveSettings);
  $("forgetKey").addEventListener("click", forgetKey);
  $("secret").addEventListener("input", updateCounter);
  $("showSecretInput").addEventListener("change", (e) => {
    ($("secret") as HTMLInputElement).type = (e.target as HTMLInputElement).checked ? "text" : "password";
  });
  $("insertSig").addEventListener("click", insertSignature);
  $("recheck").addEventListener("click", () => void scan());

  // Pinned pane: re-check whenever the selected message changes (D-007).
  mail.onItemChanged(() => {
    clearResults();
    if (Office.context.mailbox.item) mainView();
  });

  mainView();
});
