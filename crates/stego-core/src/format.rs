//! Payload wire format, version 1 (fixed size, D-014).
//!
//! ```text
//! magic(4) | version(1) | flags(1) | nonce(12) | ciphertext(138) | tag(16)   = 172 bytes
//! plaintext (138) = sent_at(u64 BE, Unix seconds) | length(u16 BE) | message UTF-8 (<=128) | zero padding
//! AAD = magic | version | flags
//! ```

pub const MAGIC: [u8; 4] = *b"OSTG";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 6;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const MAX_MESSAGE_BYTES: usize = 128;
pub const PLAINTEXT_LEN: usize = 8 + 2 + MAX_MESSAGE_BYTES;
pub const PAYLOAD_LEN: usize = HEADER_LEN + NONCE_LEN + PLAINTEXT_LEN + TAG_LEN;
/// Each payload bit is written this many times; extraction uses a majority vote.
pub const REDUNDANCY: usize = 3;

pub fn header(flags: u8) -> [u8; HEADER_LEN] {
    [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], VERSION, flags]
}

/// A decrypted payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revealed {
    pub message: String,
    /// When the signature was created (Unix seconds, sender's clock). Used to
    /// order several signatures in one thread, newest first.
    pub sent_at: u64,
}

/// Pad a message (and its timestamp) into the fixed plaintext slot.
pub fn pad(message: &str, sent_at: u64) -> crate::Result<[u8; PLAINTEXT_LEN]> {
    let bytes = message.as_bytes();
    if bytes.is_empty() {
        return Err(crate::Error::EmptyMessage);
    }
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(crate::Error::MessageTooLong(bytes.len()));
    }
    let mut out = [0u8; PLAINTEXT_LEN];
    out[..8].copy_from_slice(&sent_at.to_be_bytes());
    out[8..10].copy_from_slice(&(bytes.len() as u16).to_be_bytes());
    out[10..10 + bytes.len()].copy_from_slice(bytes);
    Ok(out)
}

pub fn unpad(plain: &[u8]) -> crate::Result<Revealed> {
    if plain.len() != PLAINTEXT_LEN {
        return Err(crate::Error::MalformedPayload);
    }
    let sent_at = u64::from_be_bytes(plain[..8].try_into().expect("8 bytes"));
    let len = u16::from_be_bytes([plain[8], plain[9]]) as usize;
    if len == 0 || len > MAX_MESSAGE_BYTES || plain[10 + len..].iter().any(|&b| b != 0) {
        return Err(crate::Error::MalformedPayload);
    }
    let message = String::from_utf8(plain[10..10 + len].to_vec()).map_err(|_| crate::Error::MalformedPayload)?;
    Ok(Revealed { message, sent_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sizes() {
        assert_eq!(PAYLOAD_LEN, 172);
    }
    #[test]
    fn pad_round_trip() {
        let r = unpad(&pad("héllo", 1_762_786_000).unwrap()).unwrap();
        assert_eq!((r.message.as_str(), r.sent_at), ("héllo", 1_762_786_000));
    }
    #[test]
    fn limits() {
        assert_eq!(pad("", 0), Err(crate::Error::EmptyMessage));
        assert!(pad(&"a".repeat(128), 0).is_ok());
        assert_eq!(pad(&"a".repeat(129), 0), Err(crate::Error::MessageTooLong(129)));
    }
}
