//! Attachments (renderer.js `attach`): text and PDF text are inlined into the message, images go as image_url parts.
use crate::core::shared::{AttKind, Attachment, fit_size};
use base64::Engine;
use image::{ImageDecoder, ImageReader};
use std::io::Cursor;

pub const MAX_FILES: usize = 5;
const MAX_IMG: u64 = 25 * 1024 * 1024;
const MAX_PDF: u64 = 25 * 1024 * 1024;
const MAX_TEXT: usize = 200_000;
const IMG_SIDE: u32 = 2048;
const KEEP_IMG: u64 = 2 * 1024 * 1024; // images are stored at most 2048 px on the long side; a small one that fits is kept as is

fn image_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}
fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// An attached image as a data URL, sized for chat. The longest side becomes at most 2048 px, which is what the big
/// vision APIs scale down to anyway, so a phone photo goes from megabytes to a few hundred KB. An image that already fits
/// and is at most 2 MB is kept byte for byte, so screenshots stay sharp and small GIFs keep their animation.
fn image_url(bytes: &[u8], mime: &str) -> Result<(String, u64), String> {
    let mut dec = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?.into_decoder().map_err(|e| e.to_string())?;
    let orientation = dec.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    if let Some(o) = orientation {
        img.apply_orientation(o); // the photo's EXIF rotation
    }
    let (w, h, scaled) = fit_size(img.width(), img.height(), IMG_SIDE);
    if !scaled && bytes.len() as u64 <= KEEP_IMG {
        return Ok((data_url(mime, bytes), bytes.len() as u64));
    }
    let img = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
    // JPEG can't keep transparency, so only images that have none become JPEG
    let alpha = mime != "image/jpeg" && img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p[3] < 255);
    let mut out = Cursor::new(vec![]);
    if alpha {
        img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
    }
    let out = out.into_inner();
    Ok((data_url(if alpha { "image/png" } else { "image/jpeg" }, &out), out.len() as u64)) // the chip shows what is actually stored and sent
}

/// The text of a PDF, extracted on this device.
fn pdf_text(bytes: &[u8]) -> Result<String, String> {
    // pdf-extract can panic on unusual files; a bad PDF must not take the app down
    match std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes)) {
        Ok(Ok(t)) => Ok(t),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("this PDF couldn't be read".into()),
    }
}

/// Turns a picked or dropped file into an attachment. Ok carries an optional note (a truncation); Err is the message to show.
pub fn attachment(name: &str, bytes: &[u8]) -> Result<(Attachment, Option<String>), String> {
    let size = bytes.len() as u64;
    if let Some(mime) = image_mime(name) {
        if size > MAX_IMG {
            return Err(format!("{name}: image is over 25 MB"));
        }
        let (url, size) = image_url(bytes, mime).map_err(|e| format!("{name}: {e}"))?;
        return Ok((Attachment { name: name.into(), size, kind: AttKind::Image(url) }, None));
    }
    let is_pdf = name.to_ascii_lowercase().ends_with(".pdf") || bytes.starts_with(b"%PDF-");
    if is_pdf && size > MAX_PDF {
        return Err(format!("{name}: PDF is over 25 MB"));
    }
    let text = if is_pdf {
        pdf_text(bytes).map_err(|e| format!("{name}: {e}"))?
    } else {
        // 4 bytes per character is the UTF-8 maximum, so this slice always holds more than MAX_TEXT characters
        let t = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_TEXT * 4)]).into_owned();
        if t.contains('\0') {
            return Err(format!("{name}: not a text file"));
        }
        t
    };
    let mut text = text.trim().to_string();
    if text.is_empty() {
        return Err(if is_pdf { format!("{name}: no text found (scanned PDF?)") } else { format!("{name} is empty") });
    }
    let mut note = None;
    if text.chars().count() > MAX_TEXT {
        text = text.chars().take(MAX_TEXT).collect::<String>() + "\n[…truncated]";
        note = Some(format!("{name} truncated to {}k characters", MAX_TEXT / 1000));
    }
    Ok((Attachment { name: name.into(), size, kind: AttKind::Text(text) }, note))
}

pub fn fmt_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1_048_576 {
        format!("{:.0} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1_048_576.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_files() {
        let (a, n) = attachment("a.txt", b"  hello  ").unwrap();
        assert_eq!((a.kind, n), (AttKind::Text("hello".into()), None));
        assert!(attachment("b.bin", b"a\0b").unwrap_err().contains("not a text file"));
        assert!(attachment("e.txt", b"   ").unwrap_err().contains("is empty"));
        let big = "x".repeat(MAX_TEXT + 5);
        let (a, n) = attachment("big.txt", big.as_bytes()).unwrap();
        assert!(matches!(a.kind, AttKind::Text(t) if t.ends_with("[…truncated]") && t.len() == MAX_TEXT + "\n[…truncated]".len()));
        assert!(n.unwrap().contains("200k"));
    }

    #[test]
    fn images_small_kept_big_scaled() {
        let mut png = Cursor::new(vec![]);
        image::RgbaImage::from_pixel(10, 10, image::Rgba([1, 2, 3, 255])).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        let (a, _) = attachment("s.PNG", &png).unwrap();
        assert!(matches!(&a.kind, AttKind::Image(u) if u.starts_with("data:image/png;base64,")));
        assert_eq!(a.size, png.len() as u64);
        let mut big = Cursor::new(vec![]);
        image::RgbImage::from_pixel(3000, 100, image::Rgb([9, 9, 9])).write_to(&mut big, image::ImageFormat::Png).unwrap();
        let (a, _) = attachment("b.png", &big.into_inner()).unwrap();
        let AttKind::Image(u) = &a.kind else { panic!() };
        assert!(u.starts_with("data:image/jpeg;base64,")); // opaque: JPEG
        let raw = base64::engine::general_purpose::STANDARD.decode(&u[u.find(',').unwrap() + 1..]).unwrap();
        assert_eq!(image::load_from_memory(&raw).unwrap().width(), 2048);
        assert!(attachment("x.png", b"not an image").is_err());
    }

    #[test]
    fn bad_pdf_is_an_error_not_a_crash() {
        assert!(attachment("x.pdf", b"%PDF-1.4 garbage").is_err());
    }

    #[test]
    fn sizes() {
        assert_eq!((fmt_size(10), fmt_size(2048), fmt_size(3 * 1_048_576)), ("10 B".into(), "2 KB".into(), "3.0 MB".into()));
    }
}
