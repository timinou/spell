//! HeadingResolver — routes markdown/org heading Op variants to code_buffer.
//!
//! Wave 2 (PLAN-304): Heading-specific Op variants (HeadingPromote,
//! HeadingDemote, HeadingReplaceBlock) delegate to the existing code_buffer
//! procedure machinery via CodeResolverImpl::apply_via_code_buffer.

use std::sync::Arc;

use pi_code_path::{
	ast::{ActionContent, MutationOutcome},
	op::Op,
	resolver::traits::{CancellationToken, MutationResolver},
	types::{Diagnostic, DiagnosticVariant},
};
use serde_json::json;

use super::code_resolver::NativeResolver;

pub struct HeadingResolver {
	inner: Arc<NativeResolver>,
}

impl HeadingResolver {
	pub fn new(inner: Arc<NativeResolver>) -> Self {
		Self { inner }
	}

	pub(crate) fn apply_to_buffer(
		&self,
		buffer: &mut pi_code_engine::buffer::CodeBuffer,
		op: &Op,
	) -> Result<MutationOutcome, Diagnostic> {
		use pi_code_path::ast::ActionContent;
		let action_json = match op {
			Op::HeadingPromote { .. } => json!({ "kind": "promote" }),
			Op::HeadingDemote { .. } => json!({ "kind": "demote" }),
			Op::HeadingReplaceBlock { content, .. } => {
				let content_str = match content {
					ActionContent::Single(s) => s.clone(),
					ActionContent::Multi(v) => v.join("\n"),
				};
				// A markdown/org section IS a declaration (the profile registers
				// `section` with name + body + span), so replacing the block under a
				// heading is exactly a whole-symbol `write` over the section node —
				// no bespoke procedure. (The old "replaceCodeBlock" routed to an
				// unregistered name and, even when mapped, targeted fenced CODE
				// blocks, not the section body — wrong semantic. BUG-439.)
				json!({
					"kind": "write",
					"content": content_str
				})
			},
			_ => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: "unexpected heading op variant".into(),
					span:    None,
				});
			},
		};
		let target = match op {
			Op::HeadingPromote { target }
			| Op::HeadingDemote { target }
			| Op::HeadingReplaceBlock { target, .. } => target,
			_ => unreachable!(),
		};
		self
			.inner
			.apply_to_buffer(buffer, target.as_codepath(), &action_json)
	}
}

impl MutationResolver for HeadingResolver {
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		match op {
			Op::HeadingPromote { target } => {
				let action_json = json!({ "kind": "promote" });
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			Op::HeadingDemote { target } => {
				let action_json = json!({ "kind": "demote" });
				Some(
					self
						.inner
						.apply_via_code_buffer(target.as_codepath(), &action_json),
				)
			},
			Op::HeadingReplaceBlock { target, content } => {
				let content_str = match content {
					ActionContent::Single(s) => s.clone(),
					ActionContent::Multi(v) => v.join("\n"),
				};
				// Section = declaration ⇒ whole-symbol write (see apply_to_buffer).
				let action_json = json!({
					"kind": "write",
					"content": content_str
				});
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
