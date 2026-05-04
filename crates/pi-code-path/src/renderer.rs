//! Renderer: CodePath AST → canonical text.
//!
//! Round-trip property: parse(render(ast)) == ast for all valid ASTs.

use std::fmt::Write;

use crate::{ast::*, dialect::NameLexer};

/// Render a CodePath AST to its canonical string form.
pub fn render_code_path<N: NameLexer>(cp: &CodePath, name_lexer: &N) -> String {
	let mut out = String::new();
	render_locator(&mut out, &cp.locator);
	if let Some(q) = &cp.query {
		out.push_str(" :: ");
		render_query(&mut out, q, name_lexer);
	}
	if let Some(qual) = &cp.qualifier {
		render_qualifier(&mut out, qual);
	}
	out
}

fn render_locator(out: &mut String, loc: &Locator) {
	match loc {
		Locator::Fs(fs) => {
			for seg in &fs.segments {
				render_fs_segment(out, seg);
			}
		},
		Locator::Uri(uri) => {
			let _ = write!(out, "{}://{}", uri.scheme, uri.path);
		},
	}
}

fn render_fs_segment(out: &mut String, seg: &FsSegment) {
	match seg {
		FsSegment::Literal(s) => {
			// Auto-quote literals containing reserved kernel/glob chars so
			// round-trip survives. Plain `/` separator literals are passed through.
			if s == "/" {
				out.push('/');
			} else if s.chars().any(|c| {
				matches!(c, ' ' | ':' | '#' | '`' | '*' | '?' | '[' | ']' | '{' | '}' | '|' | '&')
			}) {
				out.push('`');
				out.push_str(s);
				out.push('`');
			} else {
				out.push_str(s);
			}
		},
		FsSegment::Star => out.push('*'),
		FsSegment::DoubleStar => out.push_str("**"),
		FsSegment::Question => out.push('?'),
		FsSegment::CharClass(chars) => {
			out.push('[');
			for c in chars {
				out.push(*c);
			}
			out.push(']');
		},
		FsSegment::Brace(items) => {
			out.push('{');
			out.push_str(&items.join(","));
			out.push('}');
		},
	}
}

fn render_query<N: NameLexer>(out: &mut String, q: &Query, name_lexer: &N) {
	render_step(out, &q.head, name_lexer);
	for (combinator, step) in &q.chain {
		render_combinator(out, combinator);
		render_step(out, step, name_lexer);
	}
}

fn render_step<N: NameLexer>(out: &mut String, step: &Step, name_lexer: &N) {
	if let Some(axis) = &step.axis {
		let _ = write!(out, "{axis}");
	}
	render_head(out, &step.head, name_lexer);
	for predicate in &step.predicates {
		out.push('[');
		render_predicate(out, predicate, name_lexer);
		out.push(']');
	}
}

fn render_head<N: NameLexer>(out: &mut String, head: &Head, name_lexer: &N) {
	match head {
		Head::Name(payload) => out.push_str(&name_lexer.render(payload)),
		Head::NodeKind(s) => out.push_str(s),
		Head::FieldName(s) => out.push_str(s),
		Head::AnchorName(s) => out.push_str(s),
		Head::Group(q) => {
			out.push('(');
			render_query(out, q, name_lexer);
			out.push(')');
		},
	}
}

fn render_combinator(out: &mut String, c: &Combinator) {
	match c {
		Combinator::Edge(kind) => {
			let _ = write!(out, "/{kind}");
		},
		Combinator::Union | Combinator::Intersect | Combinator::Except => {
			let _ = write!(out, "{c}");
		},
		_ => {
			let _ = write!(out, "{c}");
		},
	}
}

fn render_predicate<N: NameLexer>(out: &mut String, p: &Predicate, name_lexer: &N) {
	match p {
		Predicate::Ordinal(n) => {
			if *n == -1 {
				out.push_str("last");
			} else {
				let _ = write!(out, "{n}");
			}
		},
		Predicate::Range { start, end } => {
			if let Some(s) = start {
				let _ = write!(out, "{s}");
			}
			out.push_str("..");
			if let Some(e) = end {
				let _ = write!(out, "{e}");
			}
		},
		Predicate::KindFilter(s) => {
			let _ = write!(out, "§{s}");
		},
		Predicate::AnchorFilter(s) => {
			let _ = write!(out, "¶{s}");
		},
		Predicate::HasDescendant(q) => {
			out.push('.');
			render_query(out, q, name_lexer);
		},
		Predicate::HasAncestor(q) => {
			out.push_str(".^");
			render_query(out, q, name_lexer);
		},
		Predicate::Attribute { name, value } => {
			let _ = write!(out, "{name}=\"{value}\"");
		},
		Predicate::TextMatch(re) => {
			let _ = write!(out, "text~=\"{re}\"");
		},
		Predicate::LiteralMatch(s) => {
			let _ = write!(out, "match=\"{s}\"");
		},
		Predicate::Length { op, value } => {
			let _ = write!(out, "len{}{}", render_compare_op(op), value);
		},
		Predicate::Compare { name, op, value } => {
			let _ = write!(out, "{}{}{}", name, render_compare_op(op), value);
		},
		Predicate::Flag(name) => {
			out.push_str(name);
		},
		Predicate::Count { kind, op, value } => {
			if let Some(k) = kind {
				let _ = write!(out, "§{} count{}{}", k, render_compare_op(op), value);
			} else {
				let _ = write!(out, "count{}{}", render_compare_op(op), value);
			}
		},
	}
}

fn render_compare_op(op: &CompareOp) -> &'static str {
	match op {
		CompareOp::Gt => ">",
		CompareOp::Lt => "<",
		CompareOp::Gte => ">=",
		CompareOp::Lte => "<=",
		CompareOp::Eq => "=",
		CompareOp::Neq => "!=",
	}
}

fn render_qualifier(out: &mut String, q: &Qualifier) {
	let _ = write!(out, "#{}", q.name);
	if let Some(args) = &q.args {
		let _ = write!(out, "[{args}]");
	}
}

#[cfg(test)]
mod tests {
	use winnow::{Parser, token::take_while};

	use super::*;
	use crate::parser::parse_code_path;

	struct DotLexer;

	impl NameLexer for DotLexer {
		fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
			let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
				.parse_next(input)?;
			Ok(NamePayload::Raw(s.to_string()))
		}

		fn render(&self, n: &NamePayload) -> String {
			match n {
				NamePayload::Raw(s) => s.clone(),
			}
		}

		fn matches(&self, _n: &NamePayload, _node: tree_sitter::Node<'_>, _src: &str) -> bool {
			false
		}
	}

	fn round_trip(input: &str) {
		let cp = parse_code_path(input, &DotLexer)
			.unwrap_or_else(|d| panic!("parse failed for {input:?}: {d:?}"));
		let rendered = render_code_path(&cp, &DotLexer);
		let cp2 = parse_code_path(&rendered, &DotLexer)
			.unwrap_or_else(|d| panic!("re-parse failed for {rendered:?}: {d:?}"));
		assert_eq!(cp, cp2, "AST round-trip mismatch for {input:?} → {rendered:?}");
	}

	#[test]
	fn round_trip_simple() {
		round_trip("src/api.ts");
	}

	#[test]
	fn round_trip_with_query() {
		round_trip("src/api.ts :: Foo");
	}

	#[test]
	fn round_trip_with_qualifier() {
		round_trip("src/api.ts :: Foo#body");
	}

	#[test]
	fn round_trip_descendant() {
		round_trip("src/api.ts :: Foo//§call");
	}

	#[test]
	fn round_trip_edge() {
		// The grammar requires every combinator to be followed by a step.
		// Trailing-edge form (Foo/def→) needs a special-case in the resolver,
		// not the parser. Test with explicit target after edge.
		round_trip("src/api.ts :: Foo/def→Bar");
	}

	#[test]
	fn round_trip_uri() {
		round_trip("artifact://abc/main/bash/1.txt :: §line");
	}

	#[test]
	fn round_trip_predicate() {
		round_trip("src/api.ts :: §line[text~=\"TODO\"]");
	}
}
