//! # stego-core
//!
//! Pure, transport-agnostic core for the Outlook steganography add-in.
//! Bytes in, bytes out: no Office.js, DOM, network or clock access, so the
//! same code runs as WebAssembly in any Outlook host, in the native CLI, and
//! (later) in a native mobile app. See `docs/design-and-decisions.md` (D-018).
//!
//! High-level flow:
//! * **Send:** [`derive_master_key`] (once) → [`create_signature`] → PNG bytes.
//! * **Receive:** [`extract_message`] on each candidate image → `Some(secret)` or `None`.

pub mod crypto;
pub mod error;
pub mod format;
pub mod keys;
pub mod pngio;
pub mod render;
pub mod stego;

pub use error::{Error, Result};
pub use format::{MAX_MESSAGE_BYTES, PAYLOAD_LEN};
pub use keys::{derive_master_key, derive_master_key_with_params, KdfParams, MasterKey};
pub use render::RenderOptions;

/// Render `display_name` as a cursive signature and hide an encrypted `message` in it.
///
/// `nonce` must be 12 fresh random bytes per message (the caller supplies them so
/// this crate stays free of platform RNG dependencies).
pub fn create_signature(
    key: &MasterKey,
    display_name: &str,
    message: &str,
    nonce: [u8; 12],
    options: &RenderOptions,
) -> Result<Vec<u8>> {
    let payload = crypto::seal(key, message, nonce)?;
    let mut image = render::render_signature(display_name, options)?;
    stego::embed(&mut image, &payload, &key.pixel_order_key())?;
    pngio::encode_rgb(&image)
}

/// Try to extract and decrypt a hidden message from PNG bytes.
///
/// Returns `Ok(None)` when the image carries no payload for this key (the
/// normal case for ordinary images), `Ok(Some(message))` on success, and
/// `Err` only for images that cannot be read at all.
pub fn extract_message(key: &MasterKey, png_bytes: &[u8]) -> Result<Option<String>> {
    let image = match pngio::decode(png_bytes) {
        Ok(img) => img,
        Err(Error::UnsupportedImage(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(payload) = stego::extract(&image, &key.pixel_order_key()) else {
        return Ok(None);
    };
    Ok(crypto::open(key, &payload).ok())
}

/// Quick, cheap check used before decoding: is this filename our fast-path hint
/// (`sig_*.png`)? Detection must never *rely* on this (D-006, D-018 rule 4).
pub fn is_signature_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("sig_") && lower.ends_with(".png")
}

/// Build the conventional filename for a display name, e.g. "Tim Furnell" → `sig_timfurnell.png`.
pub fn signature_filename(display_name: &str) -> String {
    let slug: String = display_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if slug.is_empty() {
        "sig.png".into()
    } else {
        format!("sig_{slug}.png")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(p: &str) -> MasterKey {
        derive_master_key_with_params(p, &KdfParams::insecure_fast_for_tests()).unwrap()
    }

    #[test]
    fn round_trip() {
        let k = key("correct horse battery staple");
        let png = create_signature(&k, "Tim Furnell", "Code: 4711-XYZ", [7; 12], &RenderOptions::default()).unwrap();
        assert_eq!(extract_message(&k, &png).unwrap().as_deref(), Some("Code: 4711-XYZ"));
    }

    #[test]
    fn wrong_key_finds_nothing() {
        let png = create_signature(&key("alpha"), "Tim Furnell", "secret", [1; 12], &RenderOptions::default()).unwrap();
        assert_eq!(extract_message(&key("beta"), &png).unwrap(), None);
    }

    #[test]
    fn plain_rendered_image_finds_nothing() {
        let img = render::render_signature("Tim Furnell", &RenderOptions::default()).unwrap();
        let png = pngio::encode_rgb(&img).unwrap();
        assert_eq!(extract_message(&key("alpha"), &png).unwrap(), None);
    }

    #[test]
    fn garbage_bytes_find_nothing() {
        assert_eq!(extract_message(&key("alpha"), b"not a png").unwrap(), None);
    }

    #[test]
    fn filenames() {
        assert_eq!(signature_filename("Tim Furnell"), "sig_timfurnell.png");
        assert!(is_signature_filename("SIG_TimFurnell.PNG"));
        assert!(!is_signature_filename("image001.png"));
    }
}
