//! Recursive-descent parser for the CodePath v3 kernel grammar.
//!
//! Uses winnow primitives for leaf tokens and explicit recursion for the
//! context-sensitive grammar (the NameLexer is dialect-pluggable).
//!
//! Grammar (per specs/code-graph/code-path-dialects/README.md §0):
//! ```text
//! CodePath   := Locator "::" Query Qualifier?
//! Locator    := UriLocator | FsLocator
//! UriLocator := Scheme "://" UriPath
//! FsLocator  := <project-relative path; literal + glob segments>
//! Query      := Step (Combinator Step)*
//! Combinator := "/" | "//" | "^" | "^^" | "<<" | ">>" | "|" | "&" | "-" | Edge
//! Edge       := EdgeKind "→"     // ref→ def→ call→ import→ bind→
//! Step       := Axis? Head Predicate*
//! Axis       := "§" | ":" | "¶"
//! Head       := NamePayload | NodeKind | FieldName | AnchorName | "(" Query ")"
//! Predicate  := "[" PredicateBody "]"
//! Qualifier  := "#" Ident Args?
//! ```

use winnow::{
	ModalResult, Parser,
	ascii::{digit1, multispace0},
	combinator::{alt, delimited, opt, preceded, repeat},
	token::{none_of, take_till, take_while},
};

use crate::{
	ast::*,
	dialect::NameLexer,
	types::{Diagnostic, DiagnosticVariant, Span},
};

// ── Public entry points ──────────────────────────────────────────

/// Parse a CodePath expression string using the given NameLexer for
/// dialect-specific name payloads.
pub fn parse_code_path<N: NameLexer>(input: &str, name_lexer: &N) -> Result<CodePath, Diagnostic> {
	let mut working = input;
	match parse_code_path_inner(&mut working, name_lexer) {
		Ok(cp) => {
			let _ = ws(&mut working);
			if !working.is_empty() {
				return Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("unexpected trailing input: {working:?}"),
					span:    Some(Span { start: input.len() - working.len(), end: input.len() }),
				});
			}
			Ok(cp)
		},
		Err(_) => Err(Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("parse failed at position {}", input.len() - working.len()),
			span:    Some(Span { start: input.len() - working.len(), end: input.len() }),
		}),
	}
}

/// Parse a Locator alone (for find-style standalone queries).
pub fn parse_locator(input: &str) -> Result<Locator, Diagnostic> {
	let mut working = input;
	locator(&mut working).map_err(|_| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("locator parse failed at {}", input.len() - working.len()),
		span:    None,
	})
}

// ── CodePath top-level (recursive descent) ──────────────────────

fn parse_code_path_inner<N: NameLexer>(input: &mut &str, name_lexer: &N) -> ModalResult<CodePath> {
	let loc = locator(input)?;
	let _ = ws(input);
	let q = if input.starts_with("::") {
		"::".parse_next(input)?;
		let _ = ws(input);
		Some(parse_query(input, name_lexer)?)
	} else {
		None
	};
	let qual = opt(qualifier).parse_next(input)?;
	Ok(CodePath { locator: loc, query: q, qualifier: qual })
}

fn parse_query<N: NameLexer>(input: &mut &str, name_lexer: &N) -> ModalResult<Query> {
	let _ = ws(input);
	let head = parse_step(input, name_lexer)?;
	let mut chain = Vec::new();
	loop {
		let snapshot = *input;
		let combinator_res = combinator(input);
		match combinator_res {
			Ok(c) => match parse_step(input, name_lexer) {
				Ok(s) => chain.push((c, s)),
				Err(_) => {
					*input = snapshot;
					break;
				},
			},
			Err(_) => {
				*input = snapshot;
				break;
			},
		}
	}
	Ok(Query { head, chain })
}

fn parse_step<N: NameLexer>(input: &mut &str, name_lexer: &N) -> ModalResult<Step> {
	let ax = opt(axis).parse_next(input)?;
	let head = match &ax {
		Some(Axis::Structural) => Head::NodeKind(ident(input)?.to_string()),
		Some(Axis::Field) => Head::FieldName(ident(input)?.to_string()),
		Some(Axis::Anchor) => Head::AnchorName(ident(input)?.to_string()),
		None => parse_head_payload(input, name_lexer)?,
	};
	let predicates: Vec<Predicate> = repeat(0.., predicate).parse_next(input)?;
	Ok(Step { axis: ax, head, predicates })
}

fn parse_head_payload<N: NameLexer>(input: &mut &str, name_lexer: &N) -> ModalResult<Head> {
	if input.starts_with('(') {
		'('.parse_next(input)?;
		let q = parse_query(input, name_lexer)?;
		')'.parse_next(input)?;
		return Ok(Head::Group(Box::new(q)));
	}
	name_lexer
		.parse(input)
		.map(Head::Name)
		.map_err(winnow::error::ErrMode::Backtrack)
}

// ── Free helpers (no NameLexer dependency) ───────────────────────

fn ws<'s>(input: &mut &'s str) -> ModalResult<&'s str> {
	multispace0.parse_next(input)
}

fn ident<'s>(input: &mut &'s str) -> ModalResult<&'s str> {
	take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '-').parse_next(input)
}

fn integer(input: &mut &str) -> ModalResult<isize> {
	let neg = opt('-').parse_next(input)?.is_some();
	let n: &str = digit1.parse_next(input)?;
	let value: isize = n
		.parse()
		.map_err(|_| winnow::error::ErrMode::Cut(winnow::error::ContextError::default()))?;
	Ok(if neg { -value } else { value })
}

fn locator(input: &mut &str) -> ModalResult<Locator> {
	alt((uri_locator.map(Locator::Uri), fs_locator.map(Locator::Fs))).parse_next(input)
}

fn uri_locator(input: &mut &str) -> ModalResult<UriLocator> {
	let scheme: &str = ident.parse_next(input)?;
	"://".parse_next(input)?;
	let path = path_until_kernel_op(input);
	Ok(UriLocator { scheme: scheme.to_string(), path })
}

fn path_until_kernel_op(input: &mut &str) -> String {
	let mut s = String::new();
	let mut consumed = 0;
	let chars = input.char_indices();
	for (idx, c) in chars {
		// Stop on "::" (kernel separator)
		if c == ':' && input[idx..].starts_with("::") {
			break;
		}
		// Stop on " ::" (with leading space)
		if c == ' ' && input[idx..].trim_start().starts_with("::") {
			break;
		}
		// Stop on "#" qualifier sigil
		if c == '#' {
			break;
		}
		// Stop on bare space (caller intends end of locator)
		if c == ' ' {
			break;
		}
		s.push(c);
		consumed = idx + c.len_utf8();
	}
	*input = &input[consumed..];
	s
}

fn fs_locator(input: &mut &str) -> ModalResult<FsLocator> {
	let raw = path_until_kernel_op(input);
	if raw.is_empty() {
		return Err(winnow::error::ErrMode::Backtrack(winnow::error::ContextError::default()));
	}
	Ok(FsLocator { segments: vec![FsSegment::Literal(raw)] })
}

fn edge_kind_p(input: &mut &str) -> ModalResult<EdgeKind> {
	alt((
		"import".value(EdgeKind::Import),
		"call".value(EdgeKind::Call),
		"bind".value(EdgeKind::Bind),
		"ref".value(EdgeKind::Ref),
		"def".value(EdgeKind::Def),
	))
	.parse_next(input)
}

fn edge_combinator(input: &mut &str) -> ModalResult<EdgeKind> {
	let kind = edge_kind_p(input)?;
	"→".parse_next(input)?;
	Ok(kind)
}

fn combinator(input: &mut &str) -> ModalResult<Combinator> {
	let _ = ws(input);
	// Try "/" + edge first (e.g. /def→), since the / would otherwise be
	// consumed as a Child combinator and the edge would fail to parse.
	let snapshot = *input;
	if input.starts_with('/') {
		let mut probe = &input[1..];
		if let Ok(kind) = edge_combinator(&mut probe) {
			*input = probe;
			let _ = ws(input);
			return Ok(Combinator::Edge(kind));
		}
		*input = snapshot;
	}
	let result = alt((
		edge_combinator.map(Combinator::Edge),
		"//".value(Combinator::Descendant),
		"/".value(Combinator::Child),
		"^^".value(Combinator::Ancestor),
		"^".value(Combinator::Parent),
		"<<".value(Combinator::PrevSibling),
		">>".value(Combinator::NextSibling),
		"|".value(Combinator::Union),
		"&".value(Combinator::Intersect),
		"-".value(Combinator::Except),
	))
	.parse_next(input)?;
	let _ = ws(input);
	Ok(result)
}

fn axis(input: &mut &str) -> ModalResult<Axis> {
	alt(("§".value(Axis::Structural), ":".value(Axis::Field), "¶".value(Axis::Anchor)))
		.parse_next(input)
}

fn predicate(input: &mut &str) -> ModalResult<Predicate> {
	delimited('[', predicate_body, ']').parse_next(input)
}

fn predicate_body(input: &mut &str) -> ModalResult<Predicate> {
	let _ = ws(input);
	alt((
		preceded((".^", ws), inner_step)
			.map(|s| Predicate::HasAncestor(Box::new(Query { head: s, chain: Vec::new() }))),
		preceded((".", ws), inner_step)
			.map(|s| Predicate::HasDescendant(Box::new(Query { head: s, chain: Vec::new() }))),
		preceded(("§", ws), ident).map(|s: &str| Predicate::KindFilter(s.to_string())),
		preceded(("¶", ws), ident).map(|s: &str| Predicate::AnchorFilter(s.to_string())),
		preceded(("text~=", ws), quoted_string).map(Predicate::TextMatch),
		preceded(("match=", ws), quoted_string).map(Predicate::LiteralMatch),
		range_predicate,
		"last".value(Predicate::Ordinal(-1)),
		integer.map(Predicate::Ordinal),
		attribute_predicate,
	))
	.parse_next(input)
}

fn inner_step(input: &mut &str) -> ModalResult<Step> {
	let ax = opt(axis).parse_next(input)?;
	let head = match &ax {
		Some(Axis::Structural) => Head::NodeKind(ident(input)?.to_string()),
		Some(Axis::Field) => Head::FieldName(ident(input)?.to_string()),
		Some(Axis::Anchor) => Head::AnchorName(ident(input)?.to_string()),
		None => {
			let s: &str =
				take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.' || c == ':')
					.parse_next(input)?;
			Head::Name(NamePayload::Raw(s.to_string()))
		},
	};
	let predicates: Vec<Predicate> = repeat(0.., predicate).parse_next(input)?;
	Ok(Step { axis: ax, head, predicates })
}

fn range_predicate(input: &mut &str) -> ModalResult<Predicate> {
	let start = opt(integer).parse_next(input)?;
	"..".parse_next(input)?;
	let end = opt(integer).parse_next(input)?;
	Ok(Predicate::Range { start, end })
}

fn attribute_predicate(input: &mut &str) -> ModalResult<Predicate> {
	let name: &str = ident.parse_next(input)?;
	'='.parse_next(input)?;
	let value = alt((quoted_string, ident.map(|s: &str| s.to_string()))).parse_next(input)?;
	Ok(Predicate::Attribute { name: name.to_string(), value })
}

fn quoted_string(input: &mut &str) -> ModalResult<String> {
	delimited(
		'"',
		repeat(0.., none_of(['"', '\\'])).fold(String::new, |mut acc, c| {
			acc.push(c);
			acc
		}),
		'"',
	)
	.parse_next(input)
}

fn qualifier(input: &mut &str) -> ModalResult<Qualifier> {
	'#'.parse_next(input)?;
	let name: &str = ident.parse_next(input)?;
	let args =
		opt(delimited('[', take_till(0.., |c: char| c == ']').map(|s: &str| s.to_string()), ']'))
			.parse_next(input)?;
	Ok(Qualifier { name: name.to_string(), args })
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use winnow::token::take_while;

	use super::*;

	/// A minimal NameLexer that consumes alphanumeric + dots.
	pub(crate) struct DotLexer;

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

	#[test]
	fn parse_simple_file_only() {
		let cp = parse_code_path("src/api.ts", &DotLexer).unwrap();
		assert!(matches!(cp.locator, Locator::Fs(_)));
		assert!(cp.query.is_none());
		assert!(cp.qualifier.is_none());
	}

	#[test]
	fn parse_file_with_symbol() {
		let cp = parse_code_path("src/api.ts::Foo", &DotLexer).unwrap();
		assert!(matches!(cp.locator, Locator::Fs(_)));
		assert!(cp.query.is_some());
	}

	#[test]
	fn parse_with_qualifier() {
		let cp = parse_code_path("src/api.ts::Foo#body", &DotLexer).unwrap();
		assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
	}

	#[test]
	fn parse_node_kind_axis() {
		let cp = parse_code_path("src/api.ts::§function", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(q.head.axis, Some(Axis::Structural)));
		assert!(matches!(q.head.head, Head::NodeKind(_)));
	}

	#[test]
	fn parse_descendant() {
		let cp = parse_code_path("src/api.ts::Foo//§call", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert_eq!(q.chain.len(), 1);
		assert!(matches!(q.chain[0].0, Combinator::Descendant));
	}

	#[test]
	fn parse_uri_locator() {
		let cp = parse_code_path("artifact://abc/main/bash/1.txt::§line", &DotLexer).unwrap();
		match &cp.locator {
			Locator::Uri(u) => {
				assert_eq!(u.scheme, "artifact");
				assert_eq!(u.path, "abc/main/bash/1.txt");
			},
			_ => panic!("expected URI"),
		}
	}

	#[test]
	fn parse_predicate_ordinal() {
		let cp = parse_code_path("src/api.ts::Foo[0]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(q.head.predicates[0], Predicate::Ordinal(0)));
	}

	#[test]
	fn parse_predicate_text_match() {
		let cp = parse_code_path(r#"src/api.ts::§line[text~="TODO"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::TextMatch(s) if s == "TODO"));
	}

	#[test]
	fn parse_kind_predicate() {
		let cp = parse_code_path("src/api.ts::Foo[§class]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::KindFilter(s) if s == "class"));
	}

	#[test]
	fn parse_anchor_predicate() {
		let cp = parse_code_path("src/api.ts::Foo[¶return]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::AnchorFilter(s) if s == "return"));
	}

	#[test]
	fn parse_range_predicate() {
		let cp = parse_code_path("src/api.ts::§line[10..20]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Range { start, end } => {
				assert_eq!(*start, Some(10));
				assert_eq!(*end, Some(20));
			},
			_ => panic!("expected range"),
		}
	}
}
