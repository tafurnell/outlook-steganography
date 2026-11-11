// Round trip through the real WASM build of stego-core (run `npm run build:wasm` first).
import { existsSync, readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../src/wasm/pkg/", import.meta.url));
const built = existsSync(pkgDir + "stego_wasm_bg.wasm");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let m: any;
let key: string;
const nonce = () => webcrypto.getRandomValues(new Uint8Array(12));
const now = () => Math.floor(Date.now() / 1000);

describe.skipIf(!built)("stego-core (WASM)", () => {
  beforeAll(async () => {
    m = await import(pkgDir + "stego_wasm.js");
    m.initSync({ module: readFileSync(pkgDir + "stego_wasm_bg.wasm") });
    key = m.deriveMasterKey("maple orbit candle river seven");
  });

  it("derives the documented test key (cross-platform stability)", () => {
    expect(key).toBe("79AffIhLoFzHvo6HOSBSaHBXfkBA1lzTNYQEzQHFAnM=");
  });

  it("round-trips a secret with any characters, and records the send time", () => {
    const secret = "Pässwörd-Ωμέγα-密码-🔑";
    const sig = m.createSignature(key, "Regards", secret, 1_762_786_000, nonce());
    const r = m.extractMessage(key, sig.png);
    expect([r.message, r.sentAt]).toEqual([secret, 1_762_786_000]);
  });

  it("finds nothing with the wrong key or in an ordinary image", () => {
    const sig = m.createSignature(key, "Tim Furnell", "x", now(), nonce());
    expect(m.extractMessage(m.deriveMasterKey("other words entirely here"), sig.png)).toBeUndefined();
    expect(m.extractMessage(key, readFileSync(fileURLToPath(new URL("../assets/icon-128.png", import.meta.url))))).toBeUndefined();
  });

  it("enforces the 128-byte limit and the minimum image width", () => {
    expect(() => m.createSignature(key, "Tim", "a".repeat(129), now(), nonce())).toThrow(/128/);
    expect(m.createSignature(key, "Tim", "a".repeat(128), now(), nonce()).width).toBe(400);
  });

  it("rejects signature text the font can't draw", () => {
    expect(() => m.createSignature(key, "Tim 😀", "x", now(), nonce())).toThrow(/font has no character/);
  });
});
