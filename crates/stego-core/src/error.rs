use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("message is empty")]
    EmptyMessage,
    #[error("message is {0} bytes; the maximum is {max} bytes", max = crate::MAX_MESSAGE_BYTES)]
    MessageTooLong(usize),
    #[error("display name is empty")]
    EmptyName,
    #[error("image is too small to carry the payload ({needed} slots needed, {available} available)")]
    ImageTooSmall { needed: usize, available: usize },
    #[error("unsupported or unreadable image: {0}")]
    UnsupportedImage(String),
    #[error("PNG encoding failed: {0}")]
    Encode(String),
    #[error("key derivation failed: {0}")]
    Kdf(String),
    #[error("invalid master key")]
    InvalidKey,
    #[error("decryption failed")]
    Decrypt,
    #[error("payload is malformed")]
    MalformedPayload,
    #[error("font error: {0}")]
    Font(String),
}

pub type Result<T> = std::result::Result<T, Error>;
