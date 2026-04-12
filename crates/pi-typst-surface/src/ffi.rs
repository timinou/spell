#![allow(
	clippy::missing_safety_doc,
	reason = "C ABI entry points are documented by naming and inline safety comments"
)]

use std::{
	ffi::{CStr, CString, c_char},
	ptr,
};

use serde::Serialize;

use crate::session::{HitTestResult, SessionConfig, SessionError, SurfaceSession, ViewportState};

fn serialize_json<T: Serialize>(value: &T) -> *mut c_char {
	match serde_json::to_string(value) {
		Ok(json) => match CString::new(json) {
			Ok(value) => value.into_raw(),
			Err(err) => CString::new(format!(r#"{{"kind":"error","message":"{err}"}}"#))
				.expect("fallback json response is valid")
				.into_raw(),
		},
		Err(err) => CString::new(format!(r#"{{"kind":"error","message":"{err}"}}"#))
			.expect("fallback json response is valid")
			.into_raw(),
	}
}

fn serialize_error(err: impl ToString) -> *mut c_char {
	serialize_json(&HitTestResult::Error { message: err.to_string() })
}

unsafe fn session_from_ptr<'a>(
	ptr: *mut SurfaceSession,
) -> Result<&'a mut SurfaceSession, SessionError> {
	if ptr.is_null() {
		return Err(SessionError::Message("Surface session pointer is null".to_string()));
	}
	// SAFETY: caller guarantees the pointer came from `typst_surface_create` and
	// remains owned here.
	Ok(unsafe { &mut *ptr })
}

unsafe fn read_c_string(input: *const c_char) -> Result<String, SessionError> {
	if input.is_null() {
		return Err(SessionError::Message("Input string pointer is null".to_string()));
	}
	// SAFETY: caller provides a NUL-terminated string pointer for the duration of
	// the call.
	unsafe { CStr::from_ptr(input) }
		.to_str()
		.map(ToString::to_string)
		.map_err(|err| SessionError::Message(format!("Invalid UTF-8 from caller: {err}")))
}

#[unsafe(no_mangle)]
pub extern "C" fn typst_surface_create(force_degraded: bool) -> *mut SurfaceSession {
	Box::into_raw(Box::new(SurfaceSession::new(SessionConfig::new(force_degraded))))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_dispose(ptr: *mut SurfaceSession) {
	if ptr.is_null() {
		return;
	}
	// SAFETY: pointer originates from `Box::into_raw` in `typst_surface_create` and
	// is consumed exactly once here.
	unsafe {
		drop(Box::from_raw(ptr));
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_set_document(
	ptr: *mut SurfaceSession,
	source: *const c_char,
) -> *mut c_char {
	// SAFETY: validated inside helpers.
	unsafe {
		match (session_from_ptr(ptr), read_c_string(source)) {
			(Ok(session), Ok(source)) => serialize_json(&session.set_document(source)),
			(Err(err), _) | (_, Err(err)) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_get_state(ptr: *mut SurfaceSession) -> *mut c_char {
	// SAFETY: validated inside helper.
	unsafe {
		match session_from_ptr(ptr) {
			Ok(session) => serialize_json(session.state()),
			Err(err) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_set_viewport(
	ptr: *mut SurfaceSession,
	viewport_json: *const c_char,
) -> *mut c_char {
	// SAFETY: validated inside helpers.
	unsafe {
		match (session_from_ptr(ptr), read_c_string(viewport_json)) {
			(Ok(session), Ok(viewport_json)) => {
				match serde_json::from_str::<ViewportState>(&viewport_json) {
					Ok(viewport) => serialize_json(&session.set_viewport(viewport)),
					Err(err) => serialize_error(format!("Invalid viewport payload: {err}")),
				}
			},
			(Err(err), _) | (_, Err(err)) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_hit_test(
	ptr: *mut SurfaceSession,
	x: f32,
	y: f32,
) -> *mut c_char {
	// SAFETY: validated inside helper.
	unsafe {
		match session_from_ptr(ptr) {
			Ok(session) => serialize_json(&session.hit_test(x, y)),
			Err(err) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_snapshot_svg(ptr: *mut SurfaceSession) -> *mut c_char {
	// SAFETY: validated inside helper.
	unsafe {
		match session_from_ptr(ptr) {
			Ok(session) => match CString::new(session.snapshot_svg()) {
				Ok(svg) => svg.into_raw(),
				Err(err) => serialize_error(format!("SVG snapshot contained an interior NUL: {err}")),
			},
			Err(err) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_last_error(ptr: *mut SurfaceSession) -> *mut c_char {
	// SAFETY: validated inside helper.
	unsafe {
		match session_from_ptr(ptr) {
			Ok(session) => match session.last_error() {
				Some(message) => CString::new(message)
					.expect("session error messages never contain NUL")
					.into_raw(),
				None => ptr::null_mut(),
			},
			Err(err) => serialize_error(err),
		}
	}
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn typst_surface_free_string(ptr: *mut c_char) {
	if ptr.is_null() {
		return;
	}
	// SAFETY: pointer originates from `CString::into_raw` above and is consumed
	// exactly once here.
	unsafe {
		drop(CString::from_raw(ptr));
	}
}
