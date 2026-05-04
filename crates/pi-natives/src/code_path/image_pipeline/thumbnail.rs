use pi_code_path::types::Diagnostic;

use crate::code_path::image_pipeline::{loader::LoadedImage, resize::resize_to_fit};

pub fn thumbnail(img: &LoadedImage, n: u32) -> Result<Vec<u8>, Diagnostic> {
    if img.width < n && img.height < n {
        return Ok(img.bytes.clone());
    }
    resize_to_fit(img, n)
}
