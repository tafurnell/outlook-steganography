//! Thin JS bindings. Keys cross the boundary as base64 strings (the form stored
//! in roamingSettings); randomness is supplied by the caller (crypto.getRandomValues)
//! so the module needs no host imports beyond wasm-bindgen's.

use base64::Engine;
use stego_core::{MasterKey, RenderOptions};
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn key_from_b64(b64: &str) -> Result<MasterKey, JsError> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| JsError::new("invalid key"))?;
    MasterKey::from_bytes(&bytes).map_err(js_err)
}

/// Maximum secret length in UTF-8 bytes.
#[wasm_bindgen(js_name = maxMessageBytes)]
pub fn max_message_bytes() -> u32 {
    stego_core::MAX_MESSAGE_BYTES as u32
}

/// Derive the master key (base64) from the shared passphrase. Slow by design (~0.5–1 s).
#[wasm_bindgen(js_name = deriveMasterKey)]
pub fn derive_master_key(passphrase: &str) -> Result<String, JsError> {
    let key = stego_core::derive_master_key(passphrase).map_err(js_err)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(key.as_bytes()))
}

#[wasm_bindgen]
pub struct Signature {
    png: Vec<u8>,
    width: u32,
    height: u32,
    file_name: String,
}

#[wasm_bindgen]
impl Signature {
    /// PNG bytes.
    #[wasm_bindgen(getter)]
    pub fn png(&self) -> Vec<u8> {
        self.png.clone()
    }
    /// Rendered (2×) pixel width; display at half.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter, js_name = fileName)]
    pub fn file_name(&self) -> String {
        self.file_name.clone()
    }
}

/// Render `displayName` and hide the encrypted `message`. `nonce` must be 12 random bytes.
#[wasm_bindgen(js_name = createSignature)]
pub fn create_signature(key_b64: &str, display_name: &str, message: &str, nonce: &[u8]) -> Result<Signature, JsError> {
    let key = key_from_b64(key_b64)?;
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| JsError::new("nonce must be 12 bytes"))?;
    let png = stego_core::create_signature(&key, display_name, message, nonce, &RenderOptions::default()).map_err(js_err)?;
    let (width, height) = stego_core::pngio::dimensions(&png).map_err(js_err)?;
    Ok(Signature { png, width, height, file_name: stego_core::signature_filename(display_name) })
}

/// Returns the hidden message, or `undefined` if this image carries none for this key.
#[wasm_bindgen(js_name = extractMessage)]
pub fn extract_message(key_b64: &str, png: &[u8]) -> Result<Option<String>, JsError> {
    let key = key_from_b64(key_b64)?;
    stego_core::extract_message(&key, png).map_err(js_err)
}

/// Fast-path filename hint check (`sig_*.png`). Never rely on it alone.
#[wasm_bindgen(js_name = isSignatureFileName)]
pub fn is_signature_file_name(name: &str) -> bool {
    stego_core::is_signature_filename(name)
}
