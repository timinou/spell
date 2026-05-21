//! CssResolver — routes CSS procedure Op variants to code_buffer.
//!
//! Wave 2 (PLAN-304): CSS-specific Op variants (CssRenameClassToken,
//! CssRenameIdToken, CssRenameCustomProp, CssRemoveDeadStyle) delegate
//! to the existing code_buffer procedure machinery via
//! CodeResolverImpl::apply_via_code_buffer.

use std::sync::Arc;

use pi_code_path::{
	ast::MutationOutcome,
	op::Op,
	resolver::traits::{CancellationToken, MutationResolver},
	types::{Diagnostic, DiagnosticVariant},
};
use serde_json::json;

use super::code_resolver::CodeResolverImpl;

pub struct CssResolver {
	inner: Arc<CodeResolverImpl>,
}

impl CssResolver {
	pub fn new(inner: Arc<CodeResolverImpl>) -> Self {
		Self { inner }
	}

	pub(crate) fn apply_to_buffer(
		&self,
		buffer: &mut pi_code_engine::buffer::CodeBuffer,
		op: &Op,
	) -> Result<MutationOutcome, Diagnostic> {
		let action_json = match op {
			Op::CssRenameClassToken { target: _, find, replace } => json!({
				"kind": "renameClassToken",
				"find": find,
				"content": replace
			}),
			Op::CssRenameIdToken { target: _, find, replace } => json!({
				"kind": "renameIdToken",
				"find": find,
				"content": replace
			}),
			Op::CssRenameCustomProp { target: _, find, replace } => json!({
				"kind": "renameCustomProperty",
				"find": find,
				"content": replace
			}),
			Op::CssRemoveDeadStyle { target: _ } => json!({ "kind": "removeDeadStyle" }),
			_ => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: "unexpected CSS op variant".into(),
					span:    None,
				});
			},
		};
		let target = match op {
			Op::CssRenameClassToken { target, .. }
			| Op::CssRenameIdToken { target, .. }
			| Op::CssRenameCustomProp { target, .. }
			| Op::CssRemoveDeadStyle { target } => target,
			_ => unreachable!(),
		};
		self.inner.apply_to_buffer(buffer, target.as_codepath(), &action_json)
	}
}

impl MutationResolver for CssResolver {
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		match op {
			Op::CssRenameClassToken { target, find, replace } => {
				let action_json = json!({
					"kind": "renameClassToken",
					"find": find,
					"content": replace
				});
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			Op::CssRenameIdToken { target, find, replace } => {
				let action_json = json!({
					"kind": "renameIdToken",
					"find": find,
					"content": replace
				});
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			Op::CssRenameCustomProp { target, find, replace } => {
				let action_json = json!({
					"kind": "renameCustomProperty",
					"find": find,
					"content": replace
				});
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			Op::CssRemoveDeadStyle { target } => {
				let action_json = json!({ "kind": "removeDeadStyle" });
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			_ => None,
		}
	}
}
