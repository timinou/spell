use napi::Result;
use napi_derive::napi;
use parking_lot::Mutex;
use pi_typst_surface::{SessionConfig, SurfaceSession, ViewportState};
use serde::Serialize;

fn serialize_json<T: Serialize>(value: &T) -> Result<String> {
	serde_json::to_string(value).map_err(|err| {
		napi::Error::from_reason(format!("Failed to serialize Typst surface payload: {err}"))
	})
}

#[napi(object)]
pub struct TypstSurfaceViewport {
	pub width:    f64,
	pub height:   f64,
	pub zoom:     f64,
	#[napi(js_name = "scrollX")]
	pub scroll_x: f64,
	#[napi(js_name = "scrollY")]
	pub scroll_y: f64,
}

#[napi(js_name = "TypstSurfaceSessionNative")]
pub struct TypstSurfaceSessionNative {
	inner: Mutex<SurfaceSession>,
}

#[napi]
impl TypstSurfaceSessionNative {
	#[napi(constructor)]
	pub fn new(force_degraded: Option<bool>) -> Self {
		Self {
			inner: Mutex::new(SurfaceSession::new(SessionConfig::new(
				force_degraded.unwrap_or(false),
			))),
		}
	}

	#[napi(js_name = "setDocument")]
	pub fn set_document(&self, source: String) -> Result<String> {
		serialize_json(&self.inner.lock().set_document(source))
	}

	#[napi(js_name = "getState")]
	pub fn get_state(&self) -> Result<String> {
		serialize_json(self.inner.lock().state())
	}

	#[napi(js_name = "setViewport")]
	pub fn set_viewport(&self, viewport: TypstSurfaceViewport) -> Result<String> {
		serialize_json(&self.inner.lock().set_viewport(ViewportState {
			width:    viewport.width as f32,
			height:   viewport.height as f32,
			zoom:     viewport.zoom as f32,
			scroll_x: viewport.scroll_x as f32,
			scroll_y: viewport.scroll_y as f32,
		}))
	}

	#[napi(js_name = "hitTest")]
	pub fn hit_test(&self, x: f64, y: f64) -> Result<String> {
		serialize_json(&self.inner.lock().hit_test(x as f32, y as f32))
	}

	#[napi(js_name = "snapshotSvg")]
	pub fn snapshot_svg(&self) -> String {
		self.inner.lock().snapshot_svg().to_string()
	}
}
