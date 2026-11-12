import {
  createSignature, deriveMasterKeyAsync, extractMessage, keyFingerprint, loadCore, maxMessageBytes, utf8Length,
} from "../core/stego";
import type { MailAdapter } from "../mail/MailAdapter";
import { evaluateSenderAuthentication, type AuthVerdict } from "../mail/authResults";
import { OfficeJsAdapter } from "../mail/OfficeJsAdapter";

import {
  KEY_SETTING, LAST_EVENT_SETTING, NAME_SETTING, RECENT_NAMES_SETTING, REMOVE_OLD_SETTING, parseRecentNames, withRecentName,
} from "../shared/settings";


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

let currentView: "settings" | "compose" | "read" = "read";
let lastItemKey = "";

function show(view: "settings" | "compose" | "read"): void {
  currentView = view;
  $("settingsView").hidden = view !== "settings";
  $("composeView").hidden = view !== "compose";
  $("readView").hidden = view !== "read";
}

const storedKey = () => mail.settings.get(KEY_SETTING);
const displayName = () => mail.settings.get(NAME_SETTING) || mail.userDisplayName();
const removeOld = () => mail.settings.get(REMOVE_OLD_SETTING) === "1";
const recentNames = () => parseRecentNames(mail.settings.get(RECENT_NAMES_SETTING));

function mainView(): void {
  lastItemKey = mail.currentItemKey();
  if (!storedKey()) {
    openSettings();
    setStatus("Set the shared passphrase to get started.");
    return;
  }
  if (mail.mode === "compose") {
    show("compose");
    ($("sigName") as HTMLInputElement).value = displayName();
    $("composeHint").innerHTML = removeOld()
      ? "Previous secure signatures in this draft are removed. <strong>Write your message first</strong> – if any are removed, Outlook moves the cursor to the end of the email."
      : "Earlier secure signatures in quoted text are kept (change in Settings).";
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
  ($("removeOld") as HTMLInputElement).checked = removeOld();
  const lastEvent = mail.settings.get(LAST_EVENT_SETTING);
  $("eventInfo").textContent = lastEvent
    ? `Automatic compose event last ran: ${new Date(lastEvent).toLocaleString()}.`
    : "Automatic compose event: not seen yet (reopen this pane after starting a new email).";
  const autoRemoved = mail.settings.get("ostg.lastAutoRemoved");
  if (lastEvent && autoRemoved) $("eventInfo").textContent += ` Last automatic removal: ${autoRemoved} old signature(s).`;
  const key = storedKey();
  $("backFromSettings").hidden = !key;
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
      ($("saveSettings") as HTMLButtonElement).disabled = true;
      try {
        await mail.settings.set(KEY_SETTING, await deriveMasterKeyAsync(pass)); // runs in a Web Worker
      } finally {
        ($("saveSettings") as HTMLButtonElement).disabled = false;
      }
      ($("passphrase") as HTMLInputElement).value = "";
    }
    await mail.settings.set(NAME_SETTING, name && name !== mail.userDisplayName() ? name : undefined);
    await mail.settings.set(REMOVE_OLD_SETTING, ($("removeOld") as HTMLInputElement).checked ? "1" : undefined);
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
    const sig = createSignature(key, name, secretEl.value);
    const report = await mail.replaceSignature(
      sig, name, (png) => extractMessage(key, png) !== undefined, [name, displayName(), ...recentNames()], removeOld(),
    );
    // Remember the text so earlier signatures can be recognised in quoted replies (D-040),
    // and remove the "Add secure signature" bar.
    await mail.settings.set(RECENT_NAMES_SETTING, JSON.stringify(withRecentName(recentNames(), name)));
    await mail.dismissComposeOffer();
    $("composeDiagList").replaceChildren(
      ...report.notes.map((n) => Object.assign(document.createElement("li"), { textContent: n })),
    );
    secretEl.value = "";
    const removed = Math.max(report.attachmentsRemoved, report.imgTagsRemoved);
    setStatus(
      removed
        ? `Signature added (removed ${report.attachmentsRemoved} old image(s), ${report.imgTagsRemoved} quoted tag(s)).`
        : removeOld()
          ? "Signature added. No previous secure signature found in this draft – see Details."
          : "Signature added.",
    );
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
  $("diagList").replaceChildren();
  $("checkedSubject").textContent = "";
  $("senderCheck").hidden = true;
  $("senderCheck").textContent = "";
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

const fmtTime = (d: Date) =>
  d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function addSecretCard(secret: string, sentAt: Date, latest: boolean | undefined, container: HTMLElement = $("results")): void {
  const tpl = $("secretCard") as HTMLTemplateElement;
  const card = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const code = card.querySelector(".secret") as HTMLElement;
  const showBtn = card.querySelector(".show") as HTMLButtonElement;
  (card.querySelector(".label") as HTMLElement).textContent =
    latest === undefined ? "Embedded secret" : latest ? "Latest secret" : "Earlier in this thread";
  (card.querySelector(".src") as HTMLElement).textContent = `– added ${fmtTime(sentAt)}`;
  if (latest === false) card.classList.add("older");

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
  container.appendChild(card);
}

async function scan(): Promise<void> {
  const gen = ++scanGeneration;
  clearResults();
  const key = storedKey();
  if (!key) return;
  setStatus("Checking for hidden messages…");
  try {
    const { subject, from, fromAddress, received, images, notes } = await mail.listCandidateImages();
    if (gen !== scanGeneration) return; // user moved to another message
    const sentBy = from ? ` from ${from}` : "";
    const when = received ? `, received ${fmtTime(received)}` : "";
    $("checkedSubject").textContent =
      `Checked: “${subject || "(no subject)"}”${sentBy}${when} (at ${new Date().toLocaleTimeString()})`;
    const decoded = new Map<string, boolean>();
    const found = images
      .map((img) => {
        const r = extractMessage(key, img.bytes);
        decoded.set(img.id, r !== undefined);
        return r;
      })
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime()); // newest first, by the time sealed inside
    if (gen !== scanGeneration) return;
    renderDiagnostics(notes, images, decoded);
    if (found.length) {
      // Sender check (D-044): only worth fetching headers when there's a secret to vouch for.
      const verdict = evaluateSenderAuthentication(await mail.getInternetHeaders(), fromAddress);
      if (gen !== scanGeneration) return;
      showSenderCheck(verdict);
      // Latest shown; earlier ones (quoted replies) collapsed.
      addSecretCard(found[0].message, found[0].sentAt, found.length === 1 ? undefined : true);
      if (found.length > 1) {
        const more = document.createElement("details");
        const summary = document.createElement("summary");
        summary.className = "hint";
        summary.textContent = `Show ${found.length - 1} earlier secret(s) from this thread`;
        more.appendChild(summary);
        found.slice(1).forEach((f) => addSecretCard(f.message, f.sentAt, false, more));
        $("results").appendChild(more);
      }
      setStatus(
        found.length === 1
          ? "This message contains an embedded secret."
          : `${found.length} embedded secrets in this thread – the latest is shown first.`,
      );
      await mail.notify("This message contains an embedded secret. Open Secure Signature to view it.");
    } else {
      const recovered = notes.some((n) => n.outcome.startsWith("fallback: extracted"));
      const failed = recovered ? 0 : notes.filter((n) => n.outcome.startsWith("read failed")).length;
      setStatus(
        failed
          ? `Couldn't read ${failed} image attachment(s) – see Details.`
          : images.length
            ? "No hidden message for your key in this email."
            : notes.length
              ? "No PNG images in this email – see Details."
              : "This email has no attachments or embedded images.",
        failed > 0,
      );
      await mail.clearNotification();
    }
  } catch (e) {
    if (gen === scanGeneration) setStatus(`Check failed: ${(e as Error).message ?? e}`, true);
  }
}

const SENDER_ICON: Record<AuthVerdict["level"], string> = { verified: "✔", warning: "⚠", failed: "✘", unknown: "?" };

function showSenderCheck(v: AuthVerdict): void {
  const el = $("senderCheck");
  el.className = `sender ${v.level}`;
  el.textContent = `${SENDER_ICON[v.level]} ${v.summary}`;
  el.hidden = false;
  const li = document.createElement("li");
  li.textContent = `Sender check: SPF ${v.spf ?? "–"}, DKIM ${v.dkim ?? "–"}, DMARC ${v.dmarc ?? "–"}, compauth ${v.compauth ?? "–"}${v.authenticatedDomain ? `, domain ${v.authenticatedDomain}` : ""}`;
  $("diagList").appendChild(li);
}

function renderDiagnostics(
  notes: import("../mail/MailAdapter").AttachmentNote[],
  images: import("../mail/MailAdapter").CandidateImage[],
  decoded: Map<string, boolean>,
): void {
  const byName = new Map(images.map((i) => [i.name, i]));
  const list = $("diagList");
  list.replaceChildren(
    ...(notes.length ? notes : [null]).map((n) => {
      const li = document.createElement("li");
      if (!n) {
        li.textContent = "No attachments reported by Outlook for this item.";
        return li;
      }
      const img = byName.get(n.name);
      const result = img ? (decoded.get(img.id) ? " → secret found" : " → no secret for this key") : "";
      li.textContent = `${n.name} (${n.contentType || "?"}, ${n.isInline ? "inline" : "attached"}, ${Math.round(n.size / 1024)} KB): ${n.outcome}${result}`;
      return li;
    }),
  );
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
  $("backFromSettings").addEventListener("click", () => mainView());
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

  // Without pinning (Outlook.com) ItemChanged doesn't fire, and new Outlook can keep
  // the pane open when you switch message or click Reply. Poll for a change of item
  // or read/compose mode and refresh the view (cheap: compares a short string).
  const refreshIfItemChanged = () => {
    if (currentView === "settings") return;
    const key = mail.currentItemKey();
    if (key !== lastItemKey) {
      clearResults();
      mainView();
    }
  };
  window.setInterval(refreshIfItemChanged, 1000);
  document.addEventListener("visibilitychange", refreshIfItemChanged);
  window.addEventListener("focus", refreshIfItemChanged);

  mainView();
});
