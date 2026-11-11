// Runs Argon2id key derivation off the UI thread so the pane stays responsive
// (~0.3–1 s of CPU). Loads its own copy of the WASM core.
import init, { deriveMasterKey } from "../wasm/pkg/stego_wasm.js";
import wasmUrl from "../wasm/pkg/stego_wasm_bg.wasm";

// Typed loosely: the DOM and WebWorker TS libs can't both be enabled.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ passphrase: string }>) => void) | null;
  postMessage(message: { key?: string; error?: string }): void;
};

let ready: Promise<unknown> | undefined;

ctx.onmessage = async (e) => {
  try {
    ready ??= init({ module_or_path: wasmUrl });
    await ready;
    ctx.postMessage({ key: deriveMasterKey(e.data.passphrase) });
  } catch (err) {
    ctx.postMessage({ error: (err as Error)?.message ?? String(err) });
  }
};
