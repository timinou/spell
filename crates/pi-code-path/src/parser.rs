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
	token::{take_till, take_while},
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

/// Consume input up to a kernel boundary: `::`, ` ::`, `#`, or bare space.
/// Backtick-quoted regions are taken verbatim so `\`weird::name with spaces\``
/// is one literal.
/// Consume input up to a kernel boundary: `::`, ` ::`, `#`, or bare space.
/// Backtick-quoted regions are taken verbatim so `\`weird::name with spaces\``
/// is one literal.
fn path_until_kernel_op(input: &mut &str) -> String {
	let mut s = String::new();
	let mut consumed = 0;
	let mut in_backtick = false;
	for (idx, c) in input.char_indices() {
		if in_backtick {
			s.push(c);
			consumed = idx + c.len_utf8();
			if c == '`' {
				in_backtick = false;
			}
			continue;
		}
		if c == '`' {
			in_backtick = true;
			s.push(c);
			consumed = idx + c.len_utf8();
			continue;
		}
		if c == ':' && input[idx..].starts_with("::") {
			break;
		}
		if c == ' ' && input[idx..].trim_start().starts_with("::") {
			break;
		}
		if c == '#' {
			break;
		}
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
	let segments = tokenise_fs_path(&raw)
		.map_err(|_| winnow::error::ErrMode::Backtrack(winnow::error::ContextError::default()))?;
	Ok(FsLocator { segments })
}

/// Tokenise a raw filesystem path string into FsSegment variants.
pub(crate) fn tokenise_fs_path(raw: &str) -> Result<Vec<FsSegment>, ()> {
	let mut out: Vec<FsSegment> = Vec::new();
	let mut buf = String::new();
	let mut chars = raw.chars().peekable();
	while let Some(c) = chars.next() {
		if c == '`' {
			let mut lit = String::new();
			let mut closed = false;
			for cc in chars.by_ref() {
				if cc == '`' {
					closed = true;
					break;
				}
				lit.push(cc);
			}
			if !closed {
				return Err(());
			}
			if !buf.is_empty() {
				flush_segment_tokens(&mut out, std::mem::take(&mut buf))?;
			}
			out.push(FsSegment::Literal(lit));
			continue;
		}
		if c == '/' {
			flush_segment_tokens(&mut out, std::mem::take(&mut buf))?;
			out.push(FsSegment::Literal("/".to_string()));
			continue;
		}
		buf.push(c);
	}
	flush_segment_tokens(&mut out, std::mem::take(&mut buf))?;
	Ok(out)
}

fn flush_segment_tokens(out: &mut Vec<FsSegment>, seg: String) -> Result<(), ()> {
	if seg.is_empty() {
		return Ok(());
	}
	let tokens = tokenise_segment(&seg)?;
	out.extend(tokens);
	Ok(())
}

/// Tokenise a single path component (between slashes) into glob primitives.
fn tokenise_segment(seg: &str) -> Result<Vec<FsSegment>, ()> {
	if !seg.chars().any(|c| matches!(c, '*' | '?' | '[' | '{')) {
		return Ok(vec![FsSegment::Literal(seg.to_string())]);
	}
	let mut out: Vec<FsSegment> = Vec::new();
	let mut buf = String::new();
	let mut chars = seg.chars().peekable();
	let flush_lit = |buf: &mut String, out: &mut Vec<FsSegment>| {
		if !buf.is_empty() {
			out.push(FsSegment::Literal(std::mem::take(buf)));
		}
	};
	while let Some(c) = chars.next() {
		match c {
			'*' => {
				flush_lit(&mut buf, &mut out);
				if chars.peek() == Some(&'*') {
					chars.next();
					if !out.is_empty() || chars.peek().is_some() {
						return Err(());
					}
					out.push(FsSegment::DoubleStar);
				} else {
					out.push(FsSegment::Star);
				}
			},
			'?' => {
				flush_lit(&mut buf, &mut out);
				out.push(FsSegment::Question);
			},
			'[' => {
				flush_lit(&mut buf, &mut out);
				let mut class: Vec<char> = Vec::new();
				let mut closed = false;
				for cc in chars.by_ref() {
					if cc == ']' {
						closed = true;
						break;
					}
					class.push(cc);
				}
				if !closed {
					return Err(());
				}
				out.push(FsSegment::CharClass(class));
			},
			'{' => {
				flush_lit(&mut buf, &mut out);
				let mut items: Vec<String> = Vec::new();
				let mut cur = String::new();
				let mut closed = false;
				for cc in chars.by_ref() {
					if cc == '}' {
						closed = true;
						break;
					}
					if cc == ',' {
						items.push(std::mem::take(&mut cur));
					} else {
						cur.push(cc);
					}
				}
				if !closed {
					return Err(());
				}
				items.push(cur);
				out.push(FsSegment::Brace { items, exclusions: vec![] });
			},
			other => buf.push(other),
		}
	}
	flush_lit(&mut buf, &mut out);
	Ok(out)
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
		range_predicate,
		preceded((".^", ws), inner_query).map(|q| Predicate::HasAncestor(Box::new(q))),
		preceded((".", ws), inner_query).map(|q| Predicate::HasDescendant(Box::new(q))),
		preceded(("§", ws), ident).map(|s: &str| Predicate::KindFilter(s.to_string())),
		preceded(("¶", ws), ident).map(|s: &str| Predicate::AnchorFilter(s.to_string())),
		preceded(("text~=", ws), quoted_string).map(Predicate::TextMatch),
		preceded(("match=", ws), quoted_string).map(Predicate::LiteralMatch),
		"last".value(Predicate::Ordinal(-1)),
		integer.map(Predicate::Ordinal),
		compare_predicate,
		attribute_predicate,
		flag_predicate,
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

/// Recursive Query parser for use inside subquery predicates `[. Q]` and `[.^
/// Q]`. Uses dialect-agnostic name parsing (kernel-generic). Supports
/// combinator chaining (`/`, `//`, `^`, `^^`, `<<`, `>>`, edge `→`, set ops
/// `|`, `&`, `-`).
fn inner_query(input: &mut &str) -> ModalResult<Query> {
	let head = inner_step(input)?;
	let mut chain: Vec<(Combinator, Step)> = Vec::new();
	loop {
		let snapshot = *input;
		let _ = ws(input);
		// Stop at `]` (end of predicate) without consuming it.
		if input.starts_with(']') {
			*input = snapshot;
			break;
		}
		let combinator_res = combinator(input);
		match combinator_res {
			Ok(c) => match inner_step(input) {
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

/// `[name OP value]` where OP ∈ {>, <, >=, <=, !=}. Equality `name=value`
/// is handled by `attribute_predicate` (kept simple so existing AST shape
/// holds for `[ext=ts]`-style attributes). The right-hand side is a free
/// token consumed up to `]` with quotes optional; resolvers normalise units.
fn compare_predicate(input: &mut &str) -> ModalResult<Predicate> {
	let name: &str = ident.parse_next(input)?;
	// Try the multi-character ops first to avoid ambiguity.
	let op: CompareOp = alt((
		">=".value(CompareOp::Gte),
		"<=".value(CompareOp::Lte),
		"!=".value(CompareOp::Neq),
		">".value(CompareOp::Gt),
		"<".value(CompareOp::Lt),
	))
	.parse_next(input)?;
	let value: String = alt((
		quoted_string,
		take_while(1.., |c: char| c != ']' && c != ' ').map(|s: &str| s.to_string()),
	))
	.parse_next(input)?;
	Ok(Predicate::Compare { name: name.to_string(), op, value })
}

/// Bare flag predicate `[empty]`, `[multiline]`, `[text]`, etc. Consumes a
/// trailing identifier; the kernel does not enumerate the recognised flags
/// (each dialect/resolver decides what flags it honours).
fn flag_predicate(input: &mut &str) -> ModalResult<Predicate> {
	let name: &str = ident.parse_next(input)?;
	Ok(Predicate::Flag(name.to_string()))
}

/// Parse a `"…"`-delimited string supporting escape sequences:
/// `\\"`, `\\\\`, `\\n`, `\\t`, `\\r`. Other escapes (`\\x` etc.) preserve the
/// `\\X` form verbatim.
fn quoted_string(input: &mut &str) -> ModalResult<String> {
	'"'.parse_next(input)?;
	let mut out = String::new();
	loop {
		let c: char = winnow::token::any.parse_next(input)?;
		match c {
			'"' => return Ok(out),
			'\\' => {
				let esc: char = winnow::token::any.parse_next(input)?;
				let rendered = match esc {
					'"' => '"',
					'\\' => '\\',
					'n' => '\n',
					't' => '\t',
					'r' => '\r',
					other => {
						out.push('\\');
						other
					},
				};
				out.push(rendered);
			},
			ch => out.push(ch),
		}
	}
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
// ── BUG-343: brace exclusions ──────────────────────────────────
#[test]
fn brace_with_exclusion() {
	let r = tokenise_segment("foo.{ts,!d.ts}").unwrap();
	match &r[..] {
		[FsSegment::Literal(prefix), FsSegment::Brace { items, exclusions }] => {
			assert_eq!(prefix, "foo.");
			assert_eq!(items, &["ts".to_string()]);
			assert_eq!(exclusions, &["d.ts".to_string()]);
		},
		_ => panic!("unexpected segments: {:?}", r),
	}
}

#[test]
fn brace_pure_exclusion_is_parse_error() {
	assert!(tokenise_segment("foo.{!d.ts}").is_err());
}

#[test]
fn brace_back_compat_no_exclusions() {
	let r = tokenise_segment("foo.{ts,tsx}").unwrap();
	assert!(
		matches!(&r[..], [_, FsSegment::Brace { items, exclusions }] if items.len() == 2 && exclusions.is_empty())
	);
}
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

	// ── PROJ-061: glob tokenisation ─────────────────────────────────

	fn fs_segs(input: &str) -> Vec<FsSegment> {
		let cp = parse_code_path(input, &DotLexer).unwrap();
		match cp.locator {
			Locator::Fs(fs) => fs.segments,
			_ => panic!("expected FS"),
		}
	}

	fn rt(input: &str) {
		let cp = parse_code_path(input, &DotLexer)
			.unwrap_or_else(|d| panic!("parse failed for {input:?}: {d:?}"));
		let rendered = crate::render_code_path(&cp, &DotLexer);
		let cp2 = parse_code_path(&rendered, &DotLexer)
			.unwrap_or_else(|d| panic!("re-parse failed for {rendered:?}: {d:?}"));
		assert_eq!(cp, cp2, "AST mismatch for {input:?} → {rendered:?}");
	}

	#[test]
	fn glob_double_star() {
		let segs = fs_segs("src/**/*.ts");
		// src / ** / *.ts → Literal("src"), Literal("/"), DoubleStar, Literal("/"),
		// Star, Literal(".ts")
		assert!(matches!(segs[0], FsSegment::Literal(ref s) if s == "src"));
		assert!(matches!(segs[1], FsSegment::Literal(ref s) if s == "/"));
		assert!(matches!(segs[2], FsSegment::DoubleStar));
		assert!(matches!(segs[3], FsSegment::Literal(ref s) if s == "/"));
		assert!(matches!(segs[4], FsSegment::Star));
		assert!(matches!(segs[5], FsSegment::Literal(ref s) if s == ".ts"));
	}

	#[test]
	fn glob_brace() {
		let segs = fs_segs("tests/**/*.{ts,rs}");
		assert!(segs.iter().any(
			|s| matches!(s, FsSegment::Brace { items, exclusions } if items == &vec!["ts".to_string(), "rs".to_string()] && exclusions.is_empty())
		));
	}

	#[test]
	fn glob_question() {
		let segs = fs_segs("src/utils?");
		assert!(segs.iter().any(|s| matches!(s, FsSegment::Question)));
	}

	#[test]
	fn glob_charclass() {
		let segs = fs_segs("src/[abc]");
		assert!(
			segs
				.iter()
				.any(|s| matches!(s, FsSegment::CharClass(c) if c == &vec!['a', 'b', 'c']))
		);
	}

	#[test]
	fn glob_star_only() {
		let segs = fs_segs("src/*.ts");
		assert!(segs.iter().any(|s| matches!(s, FsSegment::Star)));
	}

	#[test]
	fn glob_nested_braces_simple() {
		rt("src/{a,b}/*.ts");
	}

	#[test]
	fn glob_double_star_alone() {
		rt("**/*.ts");
	}

	#[test]
	fn glob_round_trip_corpus() {
		for s in &[
			"src/foo.ts",
			"src/**/*.ts",
			"tests/**/*.{ts,rs}",
			"src/utils?.ts",
			"src/[abc].ts",
			"src/{a,b,c}/*.rs",
			"a/b/c/d/e.txt",
			"./relative.md",
			"src/*",
			"src/**",
		] {
			rt(s);
		}
	}

	#[test]
	fn glob_reject_double_star_no_boundary() {
		// foo**bar (no /-boundary) must fail
		assert!(parse_code_path("src/foo**bar.ts", &DotLexer).is_err());
	}

	#[test]
	fn glob_reject_unbalanced_brace() {
		assert!(parse_code_path("src/{a,b", &DotLexer).is_err());
	}

	#[test]
	fn glob_reject_unbalanced_charclass() {
		assert!(parse_code_path("src/[abc", &DotLexer).is_err());
	}

	// ── PROJ-061: backtick quoting ─────────────────────────────────

	#[test]
	fn backtick_path_with_spaces() {
		let segs = fs_segs("`weird::name with spaces`");
		assert_eq!(segs.len(), 1);
		match &segs[0] {
			FsSegment::Literal(s) => assert_eq!(s, "weird::name with spaces"),
			_ => panic!("expected literal"),
		}
	}

	#[test]
	fn backtick_path_with_kernel_chars() {
		let segs = fs_segs("`a::b/c#d`");
		assert_eq!(segs.len(), 1);
		match &segs[0] {
			FsSegment::Literal(s) => assert_eq!(s, "a::b/c#d"),
			_ => panic!("expected literal"),
		}
	}

	#[test]
	fn backtick_round_trip() {
		rt("`weird name.rs`");
		rt("`a::b`");
	}

	#[test]
	fn backtick_unterminated_rejected() {
		assert!(parse_code_path("`unterminated", &DotLexer).is_err());
	}

	// ── PROJ-061: full predicate vocab ─────────────────────────────

	#[test]
	fn predicate_compare_size() {
		let cp = parse_code_path("src/foo.ts::Foo[size>1M]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Compare { name, op, value } => {
				assert_eq!(name, "size");
				assert!(matches!(op, CompareOp::Gt));
				assert_eq!(value, "1M");
			},
			other => panic!("expected Compare, got {other:?}"),
		}
	}

	#[test]
	fn predicate_compare_mtime() {
		let cp = parse_code_path("src/foo.ts::Foo[mtime>2026-01-01]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Compare { name, op, value } => {
				assert_eq!(name, "mtime");
				assert!(matches!(op, CompareOp::Gt));
				assert_eq!(value, "2026-01-01");
			},
			other => panic!("expected Compare, got {other:?}"),
		}
	}

	#[test]
	fn predicate_compare_len_gt() {
		let cp = parse_code_path("src/foo.ts::§line[len>80]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Compare { name, op, value } => {
				assert_eq!(name, "len");
				assert!(matches!(op, CompareOp::Gt));
				assert_eq!(value, "80");
			},
			_ => panic!("expected Compare"),
		}
	}

	#[test]
	fn predicate_compare_count_gte() {
		let cp = parse_code_path("src/foo.ts::Foo[count>=5]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Compare { name, op, value } if name == "count" && matches!(op, CompareOp::Gte) && value == "5")
		);
	}

	#[test]
	fn predicate_compare_neq() {
		let cp = parse_code_path("src/foo.ts::Foo[depth!=3]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Compare { name, op, .. } if name == "depth" && matches!(op, CompareOp::Neq))
		);
	}

	#[test]
	fn predicate_attribute_ext() {
		let cp = parse_code_path("src/foo.ts::Foo[ext=ts]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Attribute { name, value } if name == "ext" && value == "ts")
		);
	}

	#[test]
	fn predicate_attribute_lang() {
		let cp = parse_code_path("src/foo.ts::Foo[lang=rust]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Attribute { name, value } if name == "lang" && value == "rust")
		);
	}

	#[test]
	fn predicate_attribute_name_quoted() {
		let cp = parse_code_path(r#"src/foo.ts::Foo[name="*.test.ts"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Attribute { name, value } if name == "name" && value == "*.test.ts")
		);
	}

	#[test]
	fn predicate_attribute_starts_with() {
		let cp = parse_code_path(r#"src/foo.ts::§line[startsWith="//"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Attribute { name, value } if name == "startsWith" && value == "//")
		);
	}

	#[test]
	fn predicate_attribute_ends_with() {
		let cp = parse_code_path(r#"src/foo.ts::§line[endsWith="\\"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(
			matches!(&q.head.predicates[0], Predicate::Attribute { name, value } if name == "endsWith" && value == "\\")
		);
	}

	#[test]
	fn predicate_flag_empty() {
		let cp = parse_code_path("src/foo.ts::Foo[empty]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::Flag(s) if s == "empty"));
	}

	#[test]
	fn predicate_flag_multiline() {
		let cp = parse_code_path("src/foo.ts::§line[multiline]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::Flag(s) if s == "multiline"));
	}

	#[test]
	fn predicate_flag_text() {
		let cp = parse_code_path("src/foo.ts::Foo[text]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::Flag(s) if s == "text"));
	}

	#[test]
	fn predicate_round_trip_compare_corpus() {
		for s in &[
			"src/foo.ts :: §file[size>1M]",
			"src/foo.ts :: §file[size<=512K]",
			"src/foo.ts :: §file[mtime>2026-01-01]",
			"src/foo.ts :: §line[len>80]",
			"src/foo.ts :: §line[len<=120]",
			"src/foo.ts :: Foo[count>=5]",
			"src/foo.ts :: Foo[count<10]",
			"src/foo.ts :: Foo[depth!=3]",
		] {
			rt(s);
		}
	}

	#[test]
	fn predicate_round_trip_attribute_corpus() {
		for s in &[
			"src/foo.ts :: Foo[ext=ts]",
			"src/foo.ts :: Foo[lang=rust]",
			"src/foo.ts :: §file[depth=2]",
		] {
			rt(s);
		}
	}

	#[test]
	fn predicate_round_trip_flag_corpus() {
		for s in &[
			"src/foo.ts :: §file[empty]",
			"src/foo.ts :: §line[multiline]",
			"src/foo.ts :: Foo[text]",
		] {
			rt(s);
		}
	}

	// ── PROJ-061: subquery + range ─────────────────────────────────

	#[test]
	fn subquery_full_query_descendant() {
		let cp = parse_code_path("src/foo.ts::Foo[.Bar//§call_expression]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::HasDescendant(inner) => {
				assert_eq!(inner.chain.len(), 1, "expected combinator chain in subquery");
				assert!(matches!(inner.chain[0].0, Combinator::Descendant));
			},
			_ => panic!("expected HasDescendant"),
		}
	}

	#[test]
	fn subquery_full_query_ancestor() {
		let cp = parse_code_path("src/foo.ts::Foo[.^Bar/baz]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::HasAncestor(inner) => {
				assert_eq!(inner.chain.len(), 1);
			},
			_ => panic!("expected HasAncestor"),
		}
	}

	#[test]
	fn range_negative_tail() {
		let cp = parse_code_path("src/foo.ts::§line[-3..]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Range { start, end } => {
				assert_eq!(*start, Some(-3));
				assert_eq!(*end, None);
			},
			_ => panic!("expected Range"),
		}
	}

	#[test]
	fn range_negative_head() {
		let cp = parse_code_path("src/foo.ts::§line[..-1]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		match &q.head.predicates[0] {
			Predicate::Range { start, end } => {
				assert_eq!(*start, None);
				assert_eq!(*end, Some(-1));
			},
			_ => panic!("expected Range"),
		}
	}

	#[test]
	fn range_negative_both() {
		let cp = parse_code_path("src/foo.ts::§line[-5..-1]", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::Range {
			start: Some(-5),
			end:   Some(-1),
		}));
	}

	#[test]
	fn range_round_trip() {
		for s in &[
			"src/foo.ts :: §line[-3..]",
			"src/foo.ts :: §line[..-1]",
			"src/foo.ts :: §line[-5..-1]",
			"src/foo.ts :: §line[10..20]",
		] {
			rt(s);
		}
	}

	// ── PROJ-061: quoted-string escapes ────────────────────────────

	#[test]
	fn quoted_escape_quote() {
		let cp = parse_code_path(r#"src/foo.ts::§line[text~="a\"b"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::TextMatch(s) if s == "a\"b"));
	}

	#[test]
	fn quoted_escape_backslash() {
		let cp = parse_code_path(r#"src/foo.ts::§line[text~="a\\b"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::TextMatch(s) if s == "a\\b"));
	}

	#[test]
	fn quoted_escape_newline() {
		let cp = parse_code_path(r#"src/foo.ts::§line[text~="hello\nworld"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::TextMatch(s) if s == "hello\nworld"));
	}

	#[test]
	fn quoted_escape_unknown_passthrough() {
		// \\x is unknown — preserved as literal `\x`
		let cp = parse_code_path(r#"src/foo.ts::§line[text~="a\xb"]"#, &DotLexer).unwrap();
		let q = cp.query.unwrap();
		assert!(matches!(&q.head.predicates[0], Predicate::TextMatch(s) if s == "a\\xb"));
	}

	// ── PROJ-061: negative parse cases ─────────────────────────────

	#[test]
	fn neg_unbalanced_predicate_bracket() {
		assert!(parse_code_path("src/foo.ts::Foo[", &DotLexer).is_err());
	}

	#[test]
	fn neg_unbalanced_subquery() {
		assert!(parse_code_path("src/foo.ts::Foo[.Bar", &DotLexer).is_err());
	}

	#[test]
	fn neg_bad_attribute_no_value() {
		assert!(parse_code_path("src/foo.ts::Foo[ext=]", &DotLexer).is_err());
	}
}
