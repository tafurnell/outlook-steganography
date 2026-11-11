// Loads the Rust core (stego-core via stego-wasm) once and exposes a typed API.
// Generated bindings live in ../wasm/pkg (run `npm run build:wasm`).
import init, * as wasm from "../wasm/pkg/stego_wasm.js";
import wasmUrl from "../wasm/pkg/stego_wasm_bg.wasm";

let ready: Promise<void> | undefined;

export function loadCore(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return ready;
}

export interface SignatureImage {
  png: Uint8Array;
  width: number; // rendered at 2×; display at half
  height: number;
  fileName: string;
}

export const maxMessageBytes = (): number => wasm.maxMessageBytes();

/** Slow by design (Argon2id). Returns the base64 master key to store. */
export const deriveMasterKey = (passphrase: string): string => wasm.deriveMasterKey(passphrase);

export interface RevealedSecret {
  message: string;
  /** When the signature was created (sender's clock). */
  sentAt: Date;
}

/**
 * Neutral attachment name in the style Outlook itself uses for pasted/inline images
 * (image010.png … image099.png), so the name gives no hint that the add-in made it (D-036).
 * Detection never relies on the name.
 */
function neutralFileName(): string {
  const n = 10 + (crypto.getRandomValues(new Uint8Array(1))[0] % 90);
  return `image0${n}.png`;
}

export function createSignature(keyB64: string, displayName: string, message: string): SignatureImage {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const s = wasm.createSignature(keyB64, displayName, message, Math.floor(Date.now() / 1000), nonce);
  try {
    return { png: s.png, width: s.width, height: s.height, fileName: neutralFileName() };
  } finally {
    s.free();
  }
}

/** The hidden message and send time, or undefined if this image carries none for this key. */
export function extractMessage(keyB64: string, png: Uint8Array): RevealedSecret | undefined {
  const r = wasm.extractMessage(keyB64, png);
  if (!r) return undefined;
  try {
    return { message: r.message, sentAt: new Date(r.sentAt * 1000) };
  } finally {
    r.free();
  }
}

export const isSignatureFileName = (name: string): boolean => wasm.isSignatureFileName(name);

/** Short, shareable fingerprint so users can confirm they derived the same key. */
export async function keyFingerprint(keyB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
