use std::io::Cursor;

use pi_code_path::types::{Diagnostic, DiagnosticVariant};

use crate::code_path::image_pipeline::loader::LoadedImage;

pub fn resize_to_fit(img: &LoadedImage, max_edge: u32) -> Result<Vec<u8>, Diagnostic> {
    if img.mime.starts_with("image/svg") {
        return Ok(img.bytes.clone());
    }
    if img.width <= max_edge && img.height <= max_edge {
        return Ok(img.bytes.clone());
    }

    let dynamic = image::load_from_memory(&img.bytes).map_err(|e| Diagnostic {
        variant: DiagnosticVariant::ParseError,
        message: format!("failed to decode image for resize: {}", e),
        span: None,
    })?;

    let scale = (max_edge as f32 / img.width as f32).min(max_edge as f32 / img.height as f32);
    let target_w = (img.width as f32 * scale).round() as u32;
    let target_h = (img.height as f32 * scale).round() as u32;

    let resized = dynamic.resize(target_w, target_h, image::imageops::FilterType::Lanczos3);

    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    resized
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| Diagnostic {
            variant: DiagnosticVariant::ParseError,
            message: format!("failed to encode resized image to PNG: {}", e),
            span: None,
        })?;

    Ok(buf)
}
