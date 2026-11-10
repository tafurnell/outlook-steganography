//! LSB embedding in a keyed pseudo-random order with repetition coding.
//!
//! Slot = one colour channel of one pixel (index = (y * width + x) * 3 + c).
//! Positions are drawn from ChaCha20 seeded with the pixel-order key:
//! `slot = next_u64() % slot_count`, skipping duplicates, until
//! `PAYLOAD_LEN * 8 * REDUNDANCY` distinct slots are chosen. Copy `r` of bit
//! `i` (payload bytes MSB-first) goes to position `r * bit_count + i`.
//! Extraction reads the same slots and takes a majority vote per bit.

use std::collections::HashSet;

use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};

use crate::format::{PAYLOAD_LEN, REDUNDANCY};
use crate::pngio::RgbImage;
use crate::{Error, Result};

const BIT_COUNT: usize = PAYLOAD_LEN * 8;
const SLOTS_NEEDED: usize = BIT_COUNT * REDUNDANCY;

fn positions(seed: &[u8; 32], slot_count: usize) -> Option<Vec<usize>> {
    if slot_count < SLOTS_NEEDED * 2 {
        return None; // too small: refuse rather than saturate the image
    }
    let mut rng = ChaCha20Rng::from_seed(*seed);
    let mut seen = HashSet::with_capacity(SLOTS_NEEDED);
    let mut out = Vec::with_capacity(SLOTS_NEEDED);
    while out.len() < SLOTS_NEEDED {
        let s = (rng.next_u64() % slot_count as u64) as usize;
        if seen.insert(s) {
            out.push(s);
        }
    }
    Some(out)
}

pub fn embed(img: &mut RgbImage, payload: &[u8], seed: &[u8; 32]) -> Result<()> {
    if payload.len() != PAYLOAD_LEN {
        return Err(Error::MalformedPayload);
    }
    let pos = positions(seed, img.data.len()).ok_or(Error::ImageTooSmall {
        needed: SLOTS_NEEDED * 2,
        available: img.data.len(),
    })?;
    for r in 0..REDUNDANCY {
        for i in 0..BIT_COUNT {
            let bit = (payload[i / 8] >> (7 - (i % 8))) & 1;
            let slot = pos[r * BIT_COUNT + i];
            img.data[slot] = (img.data[slot] & 0xFE) | bit;
        }
    }
    Ok(())
}

/// Returns the raw (still encrypted) payload candidate, or `None` if the image
/// is too small. Callers must still verify magic + authentication tag.
pub fn extract(img: &RgbImage, seed: &[u8; 32]) -> Option<Vec<u8>> {
    let pos = positions(seed, img.data.len())?;
    let mut out = vec![0u8; PAYLOAD_LEN];
    for i in 0..BIT_COUNT {
        let ones: usize = (0..REDUNDANCY).map(|r| (img.data[pos[r * BIT_COUNT + i]] & 1) as usize).sum();
        if ones * 2 > REDUNDANCY {
            out[i / 8] |= 1 << (7 - (i % 8));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_single_copy_corruption() {
        let mut img = RgbImage::new_filled(300, 100, [255, 255, 255]);
        let payload: Vec<u8> = (0..PAYLOAD_LEN as u32).map(|i| (i * 37 % 251) as u8).collect();
        let seed = [9u8; 32];
        embed(&mut img, &payload, &seed).unwrap();
        // Flip every slot of the first copy: majority vote must still recover.
        let pos = positions(&seed, img.data.len()).unwrap();
        for &s in &pos[..BIT_COUNT] {
            img.data[s] ^= 1;
        }
        assert_eq!(extract(&img, &seed).unwrap(), payload);
    }

    #[test]
    fn too_small() {
        let mut img = RgbImage::new_filled(20, 20, [0, 0, 0]);
        assert!(matches!(embed(&mut img, &[0; PAYLOAD_LEN], &[0; 32]), Err(Error::ImageTooSmall { .. })));
        assert!(extract(&img, &[0; 32]).is_none());
    }

    #[test]
    fn positions_are_stable() {
        // Guards the cross-platform spec: changing this breaks every existing image.
        let p = positions(&[1u8; 32], 1_000_000).unwrap();
        assert_eq!(p.len(), SLOTS_NEEDED);
        let fingerprint: u64 = p.iter().take(16).fold(0u64, |a, &x| a.wrapping_mul(31).wrapping_add(x as u64));
        assert_eq!(fingerprint, POSITIONS_FINGERPRINT);
    }

    // Recorded from the first build; see positions_are_stable.
    const POSITIONS_FINGERPRINT: u64 = 1142107630316782077;
}
