// Cross-platform (Windows/macOS/Linux) build of the stego-wasm crate for the add-in.
// Requires: rustup target add wasm32-unknown-unknown
//           cargo install wasm-bindgen-cli --version <same as Cargo.lock>
// Optional: wasm-opt (npm i -g binaryen) for a smaller bundle.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "stego-wasm"]);
const wasm = join(root, "target", "wasm32-unknown-unknown", "release", "stego_wasm.wasm");
const out = join(root, "addin", "src", "wasm", "pkg");
run("wasm-bindgen", ["--target", "web", "--out-dir", out, wasm]);

const bg = join(out, "stego_wasm_bg.wasm");
try {
  run("wasm-opt", ["-Oz", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "-o", bg, bg]);
} catch {
  console.warn("wasm-opt not found – skipping size optimisation (npm i -g binaryen)");
}
if (existsSync(bg)) console.log(`stego_wasm_bg.wasm: ${(statSync(bg).size / 1024).toFixed(0)} KiB`);
