pub mod loader;
pub mod resize;
pub mod thumbnail;
#[cfg(test)]
pub mod integration_tests;

pub use loader::*;
pub use resize::*;
pub use thumbnail::*;

use pi_code_path::types::{Diagnostic, DiagnosticVariant};

/// Resolver that provides image pipeline services for `#image` and `#thumbnail[N]`.
#[derive(Debug, Clone, Default)]
pub struct ImageQualifierResolver {
    pub loader: ImageLoader,
}

/// Returns a diagnostic recommending the `inspect_image` tool for visual analysis.
pub fn inspect_image_recommendation_diag() -> Diagnostic {
    Diagnostic {
        variant: DiagnosticVariant::UnsupportedOperation,
        message: "recommend the inspect_image tool for visual analysis".to_string(),
        span: None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use image::{ImageBuffer, Rgb};
    use pi_code_path::types::DiagnosticVariant;
    use tempfile::TempDir;

    use super::*;

    fn temp_png(w: u32, h: u32, dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = if w == 2048 && h == 2048 {
            // Use new() as spec requests; all-black image compresses very well,
            // so threshold tests use a custom low threshold.
            ImageBuffer::new(w, h)
        } else {
            ImageBuffer::from_fn(w, h, |x, y| Rgb([x as u8, y as u8, 0]))
        };
        img.save(&path).unwrap();
        path
    }

    #[test]
    fn small_png_loads_without_resize() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(32, 32, &dir, "small.png");
        let opts = ImageLoader::default();
        let loaded = load(&path, &opts).unwrap();
        assert_eq!(loaded.width, 32);
        assert_eq!(loaded.height, 32);
        assert_eq!(loaded.mime, "image/png");
        assert!(!loaded.needs_resize);
    }

    #[test]
    fn large_png_triggers_resize_flag_with_low_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(512, 512, &dir, "large.png");
        let opts = ImageLoader {
            inline_threshold_bytes: 1024,
            ..Default::default()
        };
        let loaded = load(&path, &opts).unwrap();
        assert_eq!(loaded.width, 512);
        assert_eq!(loaded.height, 512);
        assert!(loaded.needs_resize);
    }

    #[test]
    fn invalid_bytes_returns_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.bin");
        std::fs::write(&path, b"not an image").unwrap();
        let opts = ImageLoader::default();
        let err = load(&path, &opts).unwrap_err();
        assert!(matches!(err.variant, DiagnosticVariant::ParseError));
    }

    #[test]
    fn svg_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.svg");
        std::fs::write(
            &path,
            r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>
"#,
        )
        .unwrap();
        let opts = ImageLoader::default();
        let loaded = load(&path, &opts).unwrap();
        assert_eq!(loaded.mime, "image/svg+xml");
        assert_eq!(loaded.width, 0);
        assert_eq!(loaded.height, 0);
        assert!(!loaded.needs_resize);
    }

    #[test]
    fn resize_to_fit_svg_returns_clone() {
        let svg = LoadedImage {
            bytes: b"<svg/>".to_vec(),
            mime: "image/svg+xml".to_string(),
            width: 0,
            height: 0,
            needs_resize: false,
        };
        let out = resize_to_fit(&svg, 256).unwrap();
        assert_eq!(out, b"<svg/>");
    }

    #[test]
    fn resize_to_fit_small_image_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(32, 32, &dir, "small.png");
        let loaded = load(&path, &ImageLoader::default()).unwrap();
        let out = resize_to_fit(&loaded, 256).unwrap();
        assert_eq!(out, loaded.bytes);
    }

    #[test]
    fn resize_to_fit_actually_resizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(512, 512, &dir, "med.png");
        let loaded = load(&path, &ImageLoader::default()).unwrap();
        let out = resize_to_fit(&loaded, 128).unwrap();
        let result = image::load_from_memory(&out).unwrap();
        assert_eq!(result.width(), 128);
        assert_eq!(result.height(), 128);
    }

    #[test]
    fn thumbnail_noop_when_smaller() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(32, 32, &dir, "tiny.png");
        let loaded = load(&path, &ImageLoader::default()).unwrap();
        let out = thumbnail(&loaded, 256).unwrap();
        assert_eq!(out, loaded.bytes);
    }

    #[test]
    fn thumbnail_resizes_when_larger() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_png(512, 256, &dir, "wide.png");
        let loaded = load(&path, &ImageLoader::default()).unwrap();
        let out = thumbnail(&loaded, 128).unwrap();
        let result = image::load_from_memory(&out).unwrap();
        assert_eq!(result.width(), 128);
        assert_eq!(result.height(), 64);
    }

    #[test]
    fn max_bytes_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.bin");
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        data.extend_from_slice(&[0u8; 2048]);
        std::fs::write(&path, &data).unwrap();
        let opts = ImageLoader {
            inline_threshold_bytes: 1024,
            max_bytes: 1024,
        };
        let err = load(&path, &opts).unwrap_err();
        assert!(matches!(err.variant, DiagnosticVariant::ParseError));
        assert!(err.message.contains("too large"));
    }
}
