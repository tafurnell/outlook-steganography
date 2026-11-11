// Pure HTML helpers for placing/removing the signature in a draft body.
// No Office.js – unit-tested in addin/test (D-038).
import type { SignatureImage } from "../core/stego";

export const SIG_CLASS = "ostg-sig";
// Outlook prefixes class names in received/quoted HTML (e.g. "x_ostg-sig").
export const SIG_CLASS_RE = /(^|[\s_])ostg-sig(\s|$)/;

/**
 * Start of the quoted original in a reply/forward body. Outlook (new/web) uses
 * <div id="appendonsend"> and <div id="divRplyFwdMsg"> (often preceded by an <hr>);
 * ids may be x_-prefixed in quoted content. Returns the element to insert before.
 */
export function findQuoteStart(doc: Document): Element | null {
  const candidates = [
    "#appendonsend", "#divRplyFwdMsg", "#x_divRplyFwdMsg",
    "[id^='mail-editor-reference-message-container']", "#divtagdefaultwrapper + hr",
  ];
  let first: Element | null = null;
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    if (el && (!first || first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) first = el;
  }
  if (!first) return null;
  // Keep the separator line with the quoted block.
  const prev = first.previousElementSibling;
  return prev && prev.tagName === "HR" ? prev : first;
}

export function signatureImgHtml(sig: SignatureImage, altText: string): string {
  const w = Math.round(sig.width / 2);
  const h = Math.round(sig.height / 2);
  const safeAlt = altText.replace(/[<>&"]/g, "");
  return `<img class="${SIG_CLASS}" src="cid:${sig.fileName}" alt="${safeAlt}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;border:0">`;
}

/**
 * Which <img> elements in a draft are earlier secure signatures: our class (possibly
 * x_-prefixed), our alt text on new Outlook's quoted placeholders, legacy sig_*.png
 * names, or a reference to an attachment we just removed (ids/names longer than 8 chars).
 */
export function selectOldSignatureImgs(imgs: Element[], altNames: string[], removedRefs: string[]): Element[] {
  const alts = altNames.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 2);
  return imgs.filter((img) => {
    const src = img.getAttribute("src") ?? "";
    const alt = (img.getAttribute("alt") ?? "").trim().toLowerCase();
    return (
      SIG_CLASS_RE.test(img.getAttribute("class") ?? "") ||
      (alt !== "" && alts.includes(alt)) ||
      /sig_[^"'/]*\.png/i.test(src) ||
      removedRefs.some((r) => r.length > 8 && src.includes(r))
    );
  });
}
