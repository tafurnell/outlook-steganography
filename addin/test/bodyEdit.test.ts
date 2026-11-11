// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findQuoteStart, selectOldSignatureImgs, signatureImgHtml } from "../src/mail/bodyEdit";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("findQuoteStart", () => {
  it("new Outlook reply: inserts before appendonsend (above the <hr> + header)", () => {
    const doc = parse(
      '<div>What?</div><div id="appendonsend"></div><hr style="display:inline-block"><div id="divRplyFwdMsg">From: Tim</div><div>old</div>',
    );
    expect(findQuoteStart(doc)?.id).toBe("appendonsend");
  });

  it("keeps the separator <hr> with the quoted block", () => {
    const doc = parse('<div>Hi</div><hr><div id="divRplyFwdMsg">From</div>');
    expect(findQuoteStart(doc)?.tagName).toBe("HR");
  });

  it("picks the earliest marker in document order", () => {
    const doc = parse('<div id="x_divRplyFwdMsg">a</div><div id="divRplyFwdMsg">b</div>');
    expect(findQuoteStart(doc)?.id).toBe("x_divRplyFwdMsg");
  });

  it("returns null for a new message", () => {
    expect(findQuoteStart(parse("<div>Hello</div>"))).toBeNull();
  });
});

describe("selectOldSignatureImgs", () => {
  const imgs = (html: string) => Array.from(parse(html).querySelectorAll("img"));

  it("matches our class, Outlook's x_ prefix, alt text (case-insensitive), legacy names, removed refs", () => {
    const list = imgs(`
      <img id="a" class="ostg-sig" src="cid:image042.png">
      <img id="b" class="x_ostg-sig" src="cid:abc">
      <img id="c" data-imagetype="AttachmentByCid" alt="Tim Furnell" src="data:image/gif;base64,R0lG">
      <img id="d" src="cid:sig_timfurnell.png">
      <img id="e" src="https://attachments.office.net/x/743811f7-41d5-4d93-bf73-8bf9df96a849/y">
      <img id="keep1" class="x_logo" src="cid:image001.png" alt="Company logo">
      <img id="keep2" class="my-ostg-signature" src="cid:other.png">`);
    const hit = selectOldSignatureImgs(list, ["tim furnell"], ["743811f7-41d5-4d93-bf73-8bf9df96a849"]).map((i) => i.id);
    expect(hit).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ignores very short alt names and short refs (avoids accidental matches)", () => {
    const list = imgs('<img id="a" alt="Ti" src="cid:x"><img id="b" src="cid:image042.png">');
    expect(selectOldSignatureImgs(list, ["Ti"], ["image042"])).toEqual([]);
  });
});

describe("signatureImgHtml", () => {
  it("displays at half the rendered size and escapes the alt text", () => {
    const html = signatureImgHtml({ png: new Uint8Array(), width: 572, height: 137, fileName: "image042.png" }, 'Tim "<b>"');
    const img = parse(html).querySelector("img")!;
    expect(img.getAttribute("src")).toBe("cid:image042.png");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["286", "69"]);
    expect(img.getAttribute("alt")).toBe("Tim b");
    expect(img.className).toBe("ostg-sig");
  });
});
