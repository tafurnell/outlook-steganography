//! Minimal PNG input/output on a simple RGB8 buffer.

use crate::{Error, Result};

/// Images larger than this many pixels are not scanned (memory guard when
/// checking arbitrary received images, e.g. on mobile later).
pub const MAX_PIXELS: u64 = 40_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    /// Row-major RGB8, `width * height * 3` bytes.
    pub data: Vec<u8>,
}

impl RgbImage {
    pub fn new_filled(width: u32, height: u32, rgb: [u8; 3]) -> Self {
        let mut data = Vec::with_capacity(width as usize * height as usize * 3);
        for _ in 0..(width as usize * height as usize) {
            data.extend_from_slice(&rgb);
        }
        RgbImage { width, height, data }
    }
}

pub fn encode_rgb(img: &RgbImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width, img.height);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Best);
        let mut w = enc.write_header().map_err(|e| Error::Encode(e.to_string()))?;
        w.write_image_data(&img.data).map_err(|e| Error::Encode(e.to_string()))?;
    }
    Ok(out)
}

/// Read the dimensions from a PNG header without decoding pixel data.
pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let dec = png::Decoder::new(std::io::Cursor::new(bytes));
    let reader = dec.read_info().map_err(|e| Error::UnsupportedImage(e.to_string()))?;
    let info = reader.info();
    Ok((info.width, info.height))
}

/// Decode an 8-bit RGB or RGBA PNG into RGB8. RGBA is accepted (alpha dropped)
/// so that a lossless RGB→RGBA conversion by a mail client doesn't destroy the payload.
pub fn decode(bytes: &[u8]) -> Result<RgbImage> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND);
    let mut reader = dec.read_info().map_err(|e| Error::UnsupportedImage(e.to_string()))?;
    let (w, h) = (reader.info().width, reader.info().height);
    if (w as u64) * (h as u64) > MAX_PIXELS {
        return Err(Error::UnsupportedImage("image too large to scan".into()));
    }
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buf).map_err(|e| Error::UnsupportedImage(e.to_string()))?;
    if frame.bit_depth != png::BitDepth::Eight {
        return Err(Error::UnsupportedImage("only 8-bit PNGs are supported".into()));
    }
    let src = &buf[..frame.buffer_size()];
    let data = match frame.color_type {
        png::ColorType::Rgb => src.to_vec(),
        // Drop every 4th byte (alpha). Written index-based so it compiles cleanly on
        // any Rust version (newer Clippy flags chunks_exact(4) in favour of as_chunks).
        png::ColorType::Rgba => src.iter().enumerate().filter(|(i, _)| i % 4 != 3).map(|(_, &b)| b).collect(),
        other => return Err(Error::UnsupportedImage(format!("colour type {other:?}"))),
    };
    Ok(RgbImage { width: w, height: h, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_decodes_to_rgb() {
        // 2×1 RGBA image → RGB with alpha dropped.
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, 2, 1);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[1, 2, 3, 255, 4, 5, 6, 128]).unwrap();
        }
        assert_eq!(decode(&out).unwrap().data, vec![1, 2, 3, 4, 5, 6]);
    }
}
