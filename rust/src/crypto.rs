//! API key encryption for the store. Desktop: AES-256-GCM with a random key kept in the OS keyring (Secret Service on
//! Linux, Credential Manager on Windows), stored as base64(nonce | ciphertext). Android: the Keystore (see android.rs).
//! Keys saved by the Electron app (Chromium os_crypt blobs) don't decrypt here, so they fail into the store's
//! "Type the key again" message instead of turning into garbage.
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Result, anyhow};
use base64::Engine;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const NONCE: usize = 12;

pub fn seal(key: &[u8; 32], text: &str) -> Result<String> {
    let mut nonce = [0u8; NONCE];
    getrandom::fill(&mut nonce)?;
    let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&nonce), text.as_bytes()).map_err(|_| anyhow!("encryption failed"))?;
    Ok(B64.encode([&nonce[..], &ct].concat()))
}
pub fn open(key: &[u8; 32], data: &str) -> Result<String> {
    let all = B64.decode(data)?;
    if all.len() <= NONCE {
        return Err(anyhow!("Not an encrypted key"));
    }
    let pt = Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&all[..NONCE]), &all[NONCE..]).map_err(|_| anyhow!("Could not decrypt"))?;
    Ok(String::from_utf8(pt)?)
}

#[cfg(not(target_os = "android"))]
pub use desktop::Keyring;
#[cfg(not(target_os = "android"))]
mod desktop {
    use super::*;
    use crate::core::store::Crypto;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// A failed keyring load is retried at most once a minute; retrying every call would show a keyring unlock prompt on every operation.
    pub(super) fn should_retry(last_fail: Option<Instant>, now: Instant) -> bool {
        last_fail.is_none_or(|t| now.duration_since(t) >= Duration::from_secs(60))
    }

    /// The app's encryption key in the OS keyring, created on first use. None when there is no working keyring,
    /// in which case keys stay in the settings file (private to the user), like the Electron app on a desktop without one.
    #[derive(Default)]
    pub struct Keyring {
        key: OnceLock<Option<[u8; 32]>>,
        last_fail: Mutex<Option<Instant>>,
    }
    impl Keyring {
        fn key(&self) -> Option<&[u8; 32]> {
            if let Some(k) = self.key.get() {
                return k.as_ref(); // a success is cached forever
            }
            let fail = self.last_fail.lock().unwrap_or_else(|e| e.into_inner());
            if !should_retry(*fail, Instant::now()) {
                return None;
            }
            drop(fail); // don't hold the mutex while talking to the keyring
            match Self::load() {
                Ok(k) => self.key.get_or_init(|| Some(k)).as_ref(),
                Err(_) => {
                    *self.last_fail.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                    None
                }
            }
        }
        fn load() -> Result<[u8; 32]> {
            // two app instances on a first run would each create a different key; an exclusive lock picks one winner
            let _lock = lock_keyring();
            let entry = keyring::Entry::new("javc-chatbot", "api-key-encryption")?;
            let stored = match entry.get_password() {
                Ok(p) => p,
                Err(keyring::Error::NoEntry) => {
                    let mut k = [0u8; 32];
                    getrandom::fill(&mut k)?;
                    entry.set_password(&B64.encode(k))?;
                    entry.get_password()? // read back, so a keyring that drops writes counts as unavailable
                }
                Err(e) => return Err(e.into()),
            };
            let k: [u8; 32] = B64.decode(stored)?.try_into().map_err(|_| anyhow!("bad key length"))?;
            (open(&k, &seal(&k, "javc")?)? == "javc").then_some(k).ok_or_else(|| anyhow!("self-test failed"))
        }
    }
    /// The cross-process lock for the keyring get-or-create, when it can be taken; the keyring still works without it.
    fn lock_keyring() -> Option<std::fs::File> {
        let dir = crate::platform::data_dir();
        std::fs::create_dir_all(&dir).ok()?;
        let f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(dir.join("keyring.lock")).ok()?; // empty: only the lock matters
        f.lock().ok()?; // released when the File is dropped
        Some(f)
    }
    impl Crypto for Keyring {
        fn available(&self) -> bool {
            self.key().is_some()
        }
        fn enc(&self, text: &str) -> Result<String> {
            seal(self.key().ok_or_else(|| anyhow!("No keyring"))?, text)
        }
        fn dec(&self, data: &str) -> Result<String> {
            open(self.key().ok_or_else(|| anyhow!("No keyring"))?, data)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "android"))]
    use super::desktop::should_retry;
    #[cfg(not(target_os = "android"))]
    use std::time::{Duration, Instant};

    #[test]
    fn round_trip_and_foreign_blobs_fail() {
        let k = [7u8; 32];
        let s = seal(&k, "sk-123").unwrap();
        assert_ne!(seal(&k, "sk-123").unwrap(), s); // a fresh nonce each time
        assert_eq!(open(&k, &s).unwrap(), "sk-123");
        assert!(open(&[8u8; 32], &s).is_err());
        // a Chromium os_crypt blob from the Electron app: "v11" + ciphertext
        assert!(open(&k, &B64.encode(b"v11\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10")).is_err());
        assert!(open(&k, "not base64!").is_err());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn keyring_failure_retries_at_most_once_a_minute() {
        let now = Instant::now();
        assert!(should_retry(None, now)); // never tried: go ahead
        assert!(!should_retry(Some(now), now));
        assert!(!should_retry(Some(now - Duration::from_secs(59)), now));
        assert!(should_retry(Some(now - Duration::from_secs(60)), now));
    }
}
