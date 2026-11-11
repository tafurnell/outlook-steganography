import type { SignatureImage } from "../core/stego";
import { isSignatureFileName } from "../core/stego";
import { extractPngParts } from "./mime";
import { findQuoteStart, selectOldSignatureImgs, signatureImgHtml } from "./bodyEdit";
import type {
  AttachmentNote, CandidateImage, ItemMode, MailAdapter, RemovalReport, ScanResult, SettingsStore,
} from "./MailAdapter";

const NOTICE_KEY = "ostgNotice";
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // don't pull huge attachments
const CACHE_PREFIX = "ostg.cache.";

function call<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((r) => (r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value) : reject(r.error))),
  );
}

/** Retry once after a short pause – Outlook sometimes returns a transient
 *  "GenericResponseError / internal error" for attachment content. */
async function callWithRetry<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void): Promise<T> {
  try {
    return await call(fn);
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return call(fn);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function looksLikePng(a: { name: string; contentType?: string }): boolean {
  return a.contentType?.toLowerCase() === "image/png" || a.name.toLowerCase().endsWith(".png");
}

/**
 * roamingSettings is the source of truth (synced via the mailbox, available on
 * mobile – D-018). A new pane instance can receive a stale snapshot, though
 * (seen in new Outlook: a key saved in a read pane was missing in the next
 * compose pane), so values are also cached in this origin's localStorage and
 * used only when roamingSettings has nothing.
 */


class RoamingSettingsStore implements SettingsStore {
  get(key: string): string | undefined {
    const v = Office.context.roamingSettings.get(key);
    if (typeof v === "string") return v;
    try {
      return localStorage.getItem(CACHE_PREFIX + key) ?? undefined;
    } catch {
      return undefined; // storage blocked
    }
  }
  async set(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) Office.context.roamingSettings.remove(key);
    else Office.context.roamingSettings.set(key, value);
    try {
      if (value === undefined) localStorage.removeItem(CACHE_PREFIX + key);
      else localStorage.setItem(CACHE_PREFIX + key, value);
    } catch {
      /* storage blocked – roamingSettings still holds it */
    }
    await call<void>((cb) => Office.context.roamingSettings.saveAsync(cb));
  }
}

export class OfficeJsAdapter implements MailAdapter {
  readonly settings: SettingsStore = new RoamingSettingsStore();

  get mode(): ItemMode {
    // Read-mode items expose displayReplyForm; compose items don't.
    const item = Office.context.mailbox.item as unknown as Record<string, unknown> | null;
    return item && typeof item["displayReplyForm"] === "function" ? "read" : "compose";
  }

  private get read(): Office.MessageRead {
    return Office.context.mailbox.item as Office.MessageRead;
  }
  private get compose(): Office.MessageCompose {
    return Office.context.mailbox.item as Office.MessageCompose;
  }

  userDisplayName(): string {
    return Office.context.mailbox.userProfile.displayName ?? "";
  }

  async listCandidateImages(): Promise<ScanResult> {
    const item = this.read;
    if (!item) return { subject: "(no message selected)", from: "", images: [], notes: [] };
    const images: CandidateImage[] = [];
    const notes: AttachmentNote[] = [];
    for (const a of item.attachments ?? []) {
      const note: AttachmentNote = {
        name: a.name, contentType: a.contentType ?? "", isInline: a.isInline, size: a.size, outcome: "",
      };
      notes.push(note);
      if (a.attachmentType !== Office.MailboxEnums.AttachmentType.File) {
        note.outcome = `skipped: attachment type ${a.attachmentType}`;
        continue;
      }
      if (!looksLikePng(a)) {
        note.outcome = "skipped: not PNG";
        continue;
      }
      if (a.size > MAX_SCAN_BYTES) {
        note.outcome = "skipped: too large";
        continue;
      }
      try {
        const content = await callWithRetry<Office.AttachmentContent>((cb) => item.getAttachmentContentAsync(a.id, cb));
        if (content.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) {
          note.outcome = `skipped: content format ${content.format}`;
          continue;
        }
        images.push({ id: a.id, name: a.name, isInline: a.isInline, hinted: isSignatureFileName(a.name), bytes: b64ToBytes(content.content) });
        note.outcome = "read";
      } catch (e) {
        const err = e as Office.Error;
        note.outcome = `read failed: ${err?.name ?? ""} ${err?.message ?? String(e)}`.trim();
        console.warn("Could not read attachment", a.name, e);
      }
    }
    // Fallback: if Outlook couldn't hand over an image, read the whole message as
    // .eml (Mailbox 1.14) and extract the PNG parts ourselves. Replaces the per-
    // attachment results so nothing is decoded twice.
    const failed = notes.some((n) => n.outcome.startsWith("read failed"));
    if (failed && Office.context.requirements.isSetSupported("Mailbox", "1.14")) {
      try {
        const emlB64 = await callWithRetry<string>((cb) => item.getAsFileAsync(cb));
        const parts = extractPngParts(atob(emlB64)).filter((p) => p.bytes.length <= MAX_SCAN_BYTES);
        notes.push({
          name: "(whole message)", contentType: "message/rfc822", isInline: false, size: emlB64.length * 0.75,
          outcome: `fallback: extracted ${parts.length} PNG part(s) from the raw message`,
        });
        images.length = 0;
        parts.forEach((p, i) =>
          images.push({ id: `eml:${i}`, name: p.name || p.contentId || `part ${i + 1}`, isInline: true, hinted: isSignatureFileName(p.name), bytes: p.bytes }),
        );
      } catch (e) {
        const err = e as Office.Error;
        notes.push({
          name: "(whole message)", contentType: "message/rfc822", isInline: false, size: 0,
          outcome: `fallback failed: ${err?.name ?? ""} ${err?.message ?? String(e)}`.trim(),
        });
      }
    }
    images.sort((x, y) => Number(y.hinted) - Number(x.hinted));
    const from = item.from?.displayName || item.from?.emailAddress || "";
    const received = item.dateTimeCreated instanceof Date ? item.dateTimeCreated : undefined;
    return { subject: item.subject ?? "", from, received, images, notes };
  }

  currentItemKey(): string {
    const item = Office.context.mailbox.item as unknown as Record<string, unknown> | null;
    if (!item) return "none";
    const id = typeof item["itemId"] === "string" ? (item["itemId"] as string) : "";
    const subject = typeof item["subject"] === "string" ? (item["subject"] as string) : "";
    return `${this.mode}|${id}|${subject}`;
  }

  async replaceSignature(
    sig: SignatureImage, altText: string, isOurs: (png: Uint8Array) => boolean, altNames: string[],
    removeOld: boolean,
  ): Promise<RemovalReport> {
    const item = this.compose;
    const notes: string[] = [];

    if (!removeOld) {
      // Default: leave earlier signatures alone and let Outlook place ours in the
      // signature area – no body rewrite, so the cursor stays where the user is.
      await call<string>((cb) => item.body.getAsync(Office.CoercionType.Html, cb));
      await call<string>((cb) =>
        item.addFileAttachmentFromBase64Async(bytesToB64(sig.png), sig.fileName, { isInline: true }, cb),
      );
      await this.placeAsSignature(signatureImgHtml(sig, altText), notes);
      notes.push("Removing previous signatures is off (Settings).");
      return { attachmentsRemoved: 0, imgTagsRemoved: 0, notes };
    }

    // 1. Attachments: remove our earlier signature images. Decode every inline PNG –
    //    names can't be trusted (new Outlook renames them to <uuid>.png).
    const atts = await call<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb));
    notes.push(`Draft has ${atts.length} attachment(s).`);
    const removedRefs: string[] = [];
    for (const a of atts) {
      const label = `${a.name} (${a.isInline ? "inline" : "attached"}, ${Math.round(a.size / 1024)} KB)`;
      if (!looksLikePng(a) || a.size > MAX_SCAN_BYTES) {
        notes.push(`${label}: skipped`);
        continue;
      }
      // Always decode: names are neutral (image0NN.png) or renamed by Outlook, so a
      // name alone must never cause someone else's image to be removed.
      let ours = false;
      try {
        const c = await callWithRetry<Office.AttachmentContent>((cb) => item.getAttachmentContentAsync(a.id, cb));
        ours = c.format === Office.MailboxEnums.AttachmentContentFormat.Base64 && isOurs(b64ToBytes(c.content));
      } catch (e) {
        const err = e as Office.Error;
        notes.push(`${label}: read failed ${err?.name ?? ""} ${err?.message ?? String(e)}`);
        continue;
      }
      if (ours) {
        try {
          await call<void>((cb) => item.removeAttachmentAsync(a.id, cb));
          removedRefs.push(a.name.replace(/\.png$/i, ""), a.id);
          notes.push(`${label}: our signature → removed`);
        } catch (e) {
          notes.push(`${label}: our signature, remove failed ${(e as Office.Error)?.message ?? e}`);
        }
      } else {
        notes.push(`${label}: not ours`);
      }
    }

    // 2. Body (read before adding the new inline image, as Microsoft recommends).
    const html = await call<string>((cb) => item.body.getAsync(Office.CoercionType.Html, cb));

    // 3. Attach the new signature image.
    await call<string>((cb) =>
      item.addFileAttachmentFromBase64Async(bytesToB64(sig.png), sig.fileName, { isInline: true }, cb),
    );
    const imgHtml = signatureImgHtml(sig, altText);

    // 4. Remove old <img> tags (our class – possibly x_-prefixed –, our alt text on new
    //    Outlook's quoted placeholders, legacy sig_ names, or references to removed attachments).
    const doc = new DOMParser().parseFromString(html, "text/html");
    const allImgs = Array.from(doc.querySelectorAll("img"));
    notes.push(`Body has ${allImgs.length} <img> tag(s):`);
    allImgs.forEach((i) => notes.push(`  ${i.outerHTML.replace(/src="data:[^"]{40,}"/, 'src="data:…"').slice(0, 300)}`));
    const oldImgs = selectOldSignatureImgs(allImgs, altNames, removedRefs);
    oldImgs.forEach((img) => img.remove());

    // 5. Nothing to remove → no rewrite needed; Outlook places the signature and the
    //    cursor is left alone.
    if (oldImgs.length === 0) {
      await this.placeAsSignature(imgHtml, notes);
      return { attachmentsRemoved: removedRefs.length / 2, imgTagsRemoved: 0, notes };
    }

    // 6. Rewrite once: old images removed, new signature directly above the quoted
    //    message (Outlook's markers) – a rewrite loses Outlook's signature position,
    //    so setSignatureAsync would otherwise append at the very end. Outlook then
    //    puts the cursor at the end of the body.
    const anchor = findQuoteStart(doc);
    if (anchor) {
      const wrapper = doc.createElement("div");
      wrapper.innerHTML = `<br>${imgHtml}<br>`;
      anchor.parentNode!.insertBefore(wrapper, anchor);
      await call<void>((cb) => item.body.setAsync(doc.documentElement.outerHTML, { coercionType: Office.CoercionType.Html }, cb));
      notes.push(`Inserted above quoted message (before <${anchor.tagName.toLowerCase()}${anchor.id ? ` id="${anchor.id}"` : ""}>).`);
    } else {
      await call<void>((cb) => item.body.setAsync(doc.documentElement.outerHTML, { coercionType: Office.CoercionType.Html }, cb));
      await this.placeAsSignature(imgHtml, notes);
    }
    return { attachmentsRemoved: removedRefs.length / 2, imgTagsRemoved: oldImgs.length, notes };
  }

  private async placeAsSignature(imgHtml: string, notes: string[]): Promise<void> {
    const item = this.compose;
    if (Office.context.requirements.isSetSupported("Mailbox", "1.10")) {
      await call<void>((cb) => item.body.setSignatureAsync(imgHtml, { coercionType: Office.CoercionType.Html }, cb));
      notes.push("Inserted in Outlook's signature area.");
    } else {
      await call<void>((cb) => item.body.setSelectedDataAsync(imgHtml, { coercionType: Office.CoercionType.Html }, cb));
      notes.push("Inserted at the cursor.");
    }
  }

  async notify(text: string): Promise<void> {
    await call<void>((cb) =>
      Office.context.mailbox.item!.notificationMessages.replaceAsync(
        NOTICE_KEY,
        { type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage, message: text, icon: "Icon.16", persistent: false },
        cb,
      ),
    );
  }

  async clearNotification(): Promise<void> {
    try {
      await call<void>((cb) => Office.context.mailbox.item!.notificationMessages.removeAsync(NOTICE_KEY, cb));
    } catch {
      /* no notice present */
    }
  }

  onItemChanged(handler: () => void): void {
    Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, handler);
  }
}
