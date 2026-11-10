//! AES-256-GCM sealing of the fixed-size payload.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::format::{self, HEADER_LEN, NONCE_LEN, PAYLOAD_LEN};
use crate::{Error, MasterKey, Result};

pub fn seal(key: &MasterKey, message: &str, nonce: [u8; NONCE_LEN]) -> Result<Vec<u8>> {
    let plain = format::pad(message)?;
    let header = format::header(0);
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key()).map_err(|_| Error::InvalidKey)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &header })
        .map_err(|_| Error::Decrypt)?;
    let mut out = Vec::with_capacity(PAYLOAD_LEN);
    out.extend_from_slice(&header);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    debug_assert_eq!(out.len(), PAYLOAD_LEN);
    Ok(out)
}

pub fn open(key: &MasterKey, payload: &[u8]) -> Result<String> {
    if payload.len() != PAYLOAD_LEN || payload[..4] != format::MAGIC {
        return Err(Error::MalformedPayload);
    }
    if payload[4] != format::VERSION {
        return Err(Error::MalformedPayload);
    }
    let (header, rest) = payload.split_at(HEADER_LEN);
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(&key.encryption_key()).map_err(|_| Error::InvalidKey)?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: header })
        .map_err(|_| Error::Decrypt)?;
    format::unpad(&plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{derive_master_key_with_params, KdfParams};

    #[test]
    fn seal_open_and_tamper() {
        let k = derive_master_key_with_params("pw", &KdfParams::insecure_fast_for_tests()).unwrap();
        let mut p = seal(&k, "hello", [3; 12]).unwrap();
        assert_eq!(open(&k, &p).unwrap(), "hello");
        p[40] ^= 1;
        assert_eq!(open(&k, &p), Err(Error::Decrypt));
    }
}
