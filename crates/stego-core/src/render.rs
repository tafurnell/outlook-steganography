//! Render a display name as a cursive (Allura) signature on an opaque background.

use ab_glyph::{point, Font, FontRef, Glyph, PxScale, ScaleFont};

use crate::pngio::RgbImage;
use crate::{Error, Result};

/// Allura, SIL Open Font License 1.1 (see assets/fonts/OFL.txt). D-013.
pub static ALLURA: &[u8] = include_bytes!("../assets/fonts/Allura-Regular.ttf");

#[derive(Clone, Debug)]
pub struct RenderOptions {
    /// Font size in pixels. Images are rendered at 2× and displayed at half size (high-DPI).
    pub font_px: f32,
    pub padding_px: u32,
    pub ink: [u8; 3],
    pub background: [u8; 3],
    /// Minimum canvas width in pixels (2×). Short texts ("Tim", "Best") get extra white
    /// space on the right so the fixed-size payload alters only a small share of the
    /// image – keeps it as hard to detect statistically as a full name (D-035).
    pub min_width_px: u32,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            font_px: 160.0,
            padding_px: 28,
            ink: [0x1F, 0x2A, 0x44],
            background: [0xFF, 0xFF, 0xFF],
            min_width_px: 400,
        }
    }
}

pub fn render_signature(name: &str, opt: &RenderOptions) -> Result<RgbImage> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::EmptyName);
    }
    let font = FontRef::try_from_slice(ALLURA).map_err(|e| Error::Font(e.to_string()))?;
    let scaled = font.as_scaled(PxScale::from(opt.font_px));

    // Lay out on a single line with kerning.
    let mut glyphs: Vec<Glyph> = Vec::new();
    let mut caret = 0.0f32;
    let mut prev = None;
    for ch in name.chars() {
        let id = scaled.glyph_id(ch);
        if let Some(p) = prev {
            caret += scaled.kern(p, id);
        }
        glyphs.push(id.with_scale_and_position(opt.font_px, point(caret, scaled.ascent())));
        caret += scaled.h_advance(id);
        prev = Some(id);
    }

    // Tight bounds over the actual outlines (cursive swashes overhang advances).
    let outlined: Vec<_> = glyphs.into_iter().filter_map(|g| font.outline_glyph(g)).collect();
    if outlined.is_empty() {
        return Err(Error::Font("no drawable glyphs for this name".into()));
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for g in &outlined {
        let b = g.px_bounds();
        min_x = min_x.min(b.min.x);
        min_y = min_y.min(b.min.y);
        max_x = max_x.max(b.max.x);
        max_y = max_y.max(b.max.y);
    }
    let pad = opt.padding_px as f32;
    // Text stays left-aligned; any extra width is white space on the right.
    let width = (((max_x - min_x) + 2.0 * pad).ceil() as u32).max(opt.min_width_px);
    let height = ((max_y - min_y) + 2.0 * pad).ceil() as u32;
    let mut img = RgbImage::new_filled(width, height, opt.background);

    for g in &outlined {
        let b = g.px_bounds();
        let ox = (b.min.x - min_x + pad).round() as i64;
        let oy = (b.min.y - min_y + pad).round() as i64;
        g.draw(|x, y, cov| {
            let (px, py) = (ox + x as i64, oy + y as i64);
            if px < 0 || py < 0 || px >= width as i64 || py >= height as i64 {
                return;
            }
            let i = (py as usize * width as usize + px as usize) * 3;
            let cov = cov.clamp(0.0, 1.0);
            for c in 0..3 {
                // Combine with what's already there (overlapping cursive joins).
                let cur = img.data[i + c] as f32;
                let target = opt.ink[c] as f32;
                img.data[i + c] = (cur + (target - cur) * cov).round() as u8;
            }
        });
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renders_reasonable_size() {
        let img = render_signature("Tim Furnell", &RenderOptions::default()).unwrap();
        assert!(img.width > 300 && img.height > 80, "{}x{}", img.width, img.height);
        assert!(img.data.iter().any(|&b| b < 128), "some ink drawn");
    }
    #[test]
    fn short_text_gets_minimum_width() {
        let img = render_signature("T", &RenderOptions::default()).unwrap();
        assert_eq!(img.width, 400);
        // Embedding density stays low: fixed payload bits vs channel slots.
        let bits = crate::PAYLOAD_LEN * 8 * crate::format::REDUNDANCY;
        assert!((bits as f64) / (img.data.len() as f64) < 0.03, "{}", img.data.len());
    }

    #[test]
    fn empty_name() {
        assert_eq!(render_signature("  ", &RenderOptions::default()).unwrap_err(), Error::EmptyName);
    }
}
