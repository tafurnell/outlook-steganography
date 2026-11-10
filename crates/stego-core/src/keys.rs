//! Key derivation (D-012): passphrase → Argon2id → master key → HKDF sub-keys.

use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Fixed, app-specific salt. It must be identical for every user so that the
/// same shared passphrase yields the same key everywhere (D-012).
pub const APP_SALT: &[u8] = b"outlook-steganography/kdf-salt/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl KdfParams {
    /// Production parameters for payload format v1 (RFC 9106 "second
    /// recommended option", single lane for WASM). Changing these changes the
    /// derived key, so they are tied to the format version.
    pub const V1: KdfParams = KdfParams { memory_kib: 64 * 1024, iterations: 3, parallelism: 1 };

    /// Cheap parameters for unit tests only.
    pub fn insecure_fast_for_tests() -> Self {
        KdfParams { memory_kib: 64, iterations: 1, parallelism: 1 }
    }
}

/// 32-byte master key derived from the shared passphrase. This (not the
/// passphrase) is what gets stored in Outlook roamingSettings.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; 32]);

impl MasterKey {
    pub fn from_bytes(bytes: &[u8]) -> crate::Result<Self> {
        let arr: [u8; 32] = bytes.try_into().map_err(|_| crate::Error::InvalidKey)?;
        Ok(MasterKey(arr))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn subkey(&self, info: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(None, &self.0);
        let mut out = [0u8; 32];
        hk.expand(info, &mut out).expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }

    /// Key for AES-256-GCM.
    pub fn encryption_key(&self) -> [u8; 32] {
        self.subkey(b"ostg/v1/aes-256-gcm")
    }

    /// Seed for the keyed pseudo-random pixel order.
    pub fn pixel_order_key(&self) -> [u8; 32] {
        self.subkey(b"ostg/v1/pixel-order")
    }
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

pub fn derive_master_key(passphrase: &str) -> crate::Result<MasterKey> {
    derive_master_key_with_params(passphrase, &KdfParams::V1)
}

pub fn derive_master_key_with_params(passphrase: &str, p: &KdfParams) -> crate::Result<MasterKey> {
    let normalized = passphrase.trim();
    if normalized.is_empty() {
        return Err(crate::Error::Kdf("passphrase is empty".into()));
    }
    let params = Params::new(p.memory_kib, p.iterations, p.parallelism, Some(32))
        .map_err(|e| crate::Error::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(normalized.as_bytes(), APP_SALT, &mut out)
        .map_err(|e| crate::Error::Kdf(e.to_string()))?;
    Ok(MasterKey(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_and_distinct() {
        let p = KdfParams::insecure_fast_for_tests();
        let a1 = derive_master_key_with_params("one two three", &p).unwrap();
        let a2 = derive_master_key_with_params("  one two three ", &p).unwrap();
        let b = derive_master_key_with_params("one two four", &p).unwrap();
        assert_eq!(a1.as_bytes(), a2.as_bytes());
        assert_ne!(a1.as_bytes(), b.as_bytes());
        assert_ne!(a1.encryption_key(), a1.pixel_order_key());
    }
    #[test]
    fn empty_rejected() {
        assert!(derive_master_key_with_params("   ", &KdfParams::insecure_fast_for_tests()).is_err());
    }
}
