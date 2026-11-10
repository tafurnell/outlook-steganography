import type { SignatureImage } from "../core/stego";
import { isSignatureFileName } from "../core/stego";
import type { CandidateImage, ItemMode, MailAdapter, SettingsStore } from "./MailAdapter";

const NOTICE_KEY = "ostgNotice";
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // don't pull huge attachments
const SIG_CLASS = "ostg-sig";

function call<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((r) => (r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value) : reject(r.error))),
  );
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

class RoamingSettingsStore implements SettingsStore {
  get(key: string): string | undefined {
    const v = Office.context.roamingSettings.get(key);
    return typeof v === "string" ? v : undefined;
  }
  async set(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) Office.context.roamingSettings.remove(key);
    else Office.context.roamingSettings.set(key, value);
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

  async listCandidateImages(): Promise<CandidateImage[]> {
    const item = this.read;
    if (!item) return [];
    const atts = (item.attachments ?? []).filter(
      (a) => a.attachmentType === Office.MailboxEnums.AttachmentType.File && looksLikePng(a) && a.size <= MAX_SCAN_BYTES,
    );
    const out: CandidateImage[] = [];
    for (const a of atts) {
      try {
        const content = await call<Office.AttachmentContent>((cb) => item.getAttachmentContentAsync(a.id, cb));
        if (content.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) continue;
        out.push({ id: a.id, name: a.name, isInline: a.isInline, hinted: isSignatureFileName(a.name), bytes: b64ToBytes(content.content) });
      } catch (e) {
        console.warn("Could not read attachment", a.name, e);
      }
    }
    return out.sort((x, y) => Number(y.hinted) - Number(x.hinted));
  }

  async removeExistingSignatures(): Promise<number> {
    const item = this.compose;
    let removed = 0;
    const atts = await call<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb));
    for (const a of atts) {
      if (isSignatureFileName(a.name)) {
        await call<void>((cb) => item.removeAttachmentAsync(a.id, cb));
        removed++;
      }
    }
    // Best effort: drop <img> tags that referenced them (quoted replies). If the
    // client mangles formatting, fall back to attachment removal only (D-010).
    const html = await call<string>((cb) => item.body.getAsync(Office.CoercionType.Html, cb));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = Array.from(doc.querySelectorAll("img")).filter(
      (img) => img.classList.contains(SIG_CLASS) || /cid:sig_[^"']*\.png/i.test(img.getAttribute("src") ?? ""),
    );
    if (imgs.length) {
      imgs.forEach((img) => img.remove());
      await call<void>((cb) => item.body.setAsync(doc.documentElement.outerHTML, { coercionType: Office.CoercionType.Html }, cb));
      removed = Math.max(removed, imgs.length);
    }
    return removed;
  }

  async insertSignature(sig: SignatureImage, altText: string): Promise<void> {
    const item = this.compose;
    await call<string>((cb) =>
      item.addFileAttachmentFromBase64Async(bytesToB64(sig.png), sig.fileName, { isInline: true }, cb),
    );
    const w = Math.round(sig.width / 2);
    const h = Math.round(sig.height / 2);
    const safeAlt = altText.replace(/[<>&"]/g, "");
    const img = `<img class="${SIG_CLASS}" src="cid:${sig.fileName}" alt="${safeAlt}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;border:0">`;
    if (Office.context.requirements.isSetSupported("Mailbox", "1.10")) {
      // Places it in the signature area (above quoted text on replies).
      await call<void>((cb) => item.body.setSignatureAsync(img, { coercionType: Office.CoercionType.Html }, cb));
    } else {
      await call<void>((cb) => item.body.setSelectedDataAsync(img, { coercionType: Office.CoercionType.Html }, cb));
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
