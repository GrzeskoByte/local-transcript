pub mod csrf;
pub mod local;
pub mod oidc;
pub mod session;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

pub fn random_hex<const N: usize>() -> String {
    hex(&random::<N>())
}

pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(random::<32>())
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 43 && URL_SAFE_NO_PAD.decode(token).is_ok()
}

pub fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("write to String");
    }
    output
}

pub fn seal(key: &[u8; 32], purpose: &[u8], value: &impl Serialize) -> Result<String> {
    let nonce = random::<24>();
    let message = serde_json::to_vec(value)?;
    let ciphertext = XChaCha20Poly1305::new(key.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &message,
                aad: purpose,
            },
        )
        .map_err(|_| anyhow!("Could not encrypt data"))?;
    Ok(URL_SAFE_NO_PAD.encode([nonce.as_slice(), &ciphertext].concat()))
}

pub fn unseal<T: DeserializeOwned>(key: &[u8; 32], purpose: &[u8], value: &str) -> Result<T> {
    let bytes = URL_SAFE_NO_PAD.decode(value)?;
    let (nonce, ciphertext) = bytes
        .split_at_checked(24)
        .ok_or_else(|| anyhow!("Invalid encrypted data"))?;
    let message = XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: purpose,
            },
        )
        .map_err(|_| anyhow!("Invalid encrypted data"))?;
    Ok(serde_json::from_slice(&message)?)
}
