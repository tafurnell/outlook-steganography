import { describe, expect, it } from "vitest";
import { extractPngParts } from "../src/mail/mime";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 250, 251, 252]);
const b64 = (bytes: Uint8Array, wrap = 76) =>
  Buffer.from(bytes).toString("base64").replace(new RegExp(`.{${wrap}}`, "g"), "$&\r\n");

function eml(parts: string[]): string {
  return [
    "From: Tim <t@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed;",
    '\tboundary="_mixed_"', // folded header
    "",
    "preamble",
    ...parts.flatMap((p) => ["--_mixed_", p]),
    "--_mixed_--",
    "epilogue",
  ].join("\r\n");
}

describe("extractPngParts", () => {
  it("finds inline and attached PNGs in nested multiparts (CRLF, folded headers)", () => {
    const related = [
      'Content-Type: multipart/related; boundary="_rel_"',
      "",
      "--_rel_",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hi <img src="cid:image042.png"></p>',
      "--_rel_",
      'Content-Type: image/png; name="image042.png"',
      "Content-ID: <image042.png>",
      'Content-Disposition: inline;\r\n\tfilename="image042.png"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(PNG, 8),
      "--_rel_--",
    ].join("\r\n");
    const attached = [
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="logo.PNG"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(PNG),
    ].join("\r\n");
    const parts = extractPngParts(eml([related, attached]));
    expect(parts.map((p) => [p.name, p.contentId])).toEqual([
      ["image042.png", "image042.png"],
      ["logo.PNG", ""],
    ]);
    parts.forEach((p) => expect(Array.from(p.bytes)).toEqual(Array.from(PNG)));
  });

  it("ignores non-PNG and non-base64 parts", () => {
    const jpeg = ["Content-Type: image/jpeg", "Content-Transfer-Encoding: base64", "", b64(PNG)].join("\r\n");
    const qp = ['Content-Type: image/png; name="x.png"', "Content-Transfer-Encoding: quoted-printable", "", "abc"].join("\r\n");
    expect(extractPngParts(eml([jpeg, qp]))).toEqual([]);
  });

  it("handles a single-part message and LF line endings", () => {
    const single = ["Content-Type: image/png", "Content-Transfer-Encoding: base64", "", b64(PNG)].join("\n");
    expect(extractPngParts(single)).toHaveLength(1);
  });
});
