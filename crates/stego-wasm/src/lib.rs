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

/// Render `displayName` and hide the encrypted `message`. `sentAt` is Unix seconds
/// (`Math.floor(Date.now() / 1000)`); `nonce` must be 12 random bytes.
#[wasm_bindgen(js_name = createSignature)]
pub fn create_signature(key_b64: &str, display_name: &str, message: &str, sent_at: f64, nonce: &[u8]) -> Result<Signature, JsError> {
    let key = key_from_b64(key_b64)?;
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| JsError::new("nonce must be 12 bytes"))?;
    if !(sent_at.is_finite() && sent_at >= 0.0) {
        return Err(JsError::new("sentAt must be a non-negative number of seconds"));
    }
    let png = stego_core::create_signature(&key, display_name, message, sent_at as u64, nonce, &RenderOptions::default())
        .map_err(js_err)?;
    let (width, height) = stego_core::pngio::dimensions(&png).map_err(js_err)?;
    Ok(Signature { png, width, height, file_name: stego_core::signature_filename(display_name) })
}

#[wasm_bindgen]
pub struct Revealed {
    message: String,
    sent_at: f64,
}

#[wasm_bindgen]
impl Revealed {
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }
    /// Unix seconds.
    #[wasm_bindgen(getter, js_name = sentAt)]
    pub fn sent_at(&self) -> f64 {
        self.sent_at
    }
}

/// Returns the hidden message and its send time, or `undefined` if this image carries none for this key.
#[wasm_bindgen(js_name = extractMessage)]
pub fn extract_message(key_b64: &str, png: &[u8]) -> Result<Option<Revealed>, JsError> {
    let key = key_from_b64(key_b64)?;
    Ok(stego_core::extract_message(&key, png)
        .map_err(js_err)?
        .map(|r| Revealed { message: r.message, sent_at: r.sent_at as f64 }))
}

/// Fast-path filename hint check (`sig_*.png`). Never rely on it alone.
#[wasm_bindgen(js_name = isSignatureFileName)]
pub fn is_signature_file_name(name: &str) -> bool {
    stego_core::is_signature_filename(name)
}
