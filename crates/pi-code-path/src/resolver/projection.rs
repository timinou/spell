//! Projection-option lowering.
//!
//! Translates ergonomic projection options (limit, head, tail, offset,
//! context) into canonical CodePath predicates and combinators so that
//! the resolver sees a single uniform query.

use crate::ast::{Combinator, Predicate, Query, Step};

/// Projection options that can be lowered into query predicates.
#[derive(Debug, Clone, Default)]
pub struct ProjectionOpts {
	pub limit:   Option<usize>,
	pub head:    Option<usize>,
	pub tail:    Option<usize>,
	pub context: Option<ContextOpts>,
	pub offset:  Option<usize>,
}

/// Context-window options (pre / post lines).
#[derive(Debug, Clone, Default)]
pub struct ContextOpts {
	pub pre:  Option<usize>,
	pub post: Option<usize>,
}

/// Append a predicate to the last step of a query.
fn append_predicate(mut q: Query, pred: Predicate) -> Query {
	if q.chain.is_empty() {
		q.head.predicates.push(pred);
	} else {
		let last = q.chain.len() - 1;
		q.chain[last].1.predicates.push(pred);
	}
	q
}

/// Prepend a combinator-step pair to the query chain.
fn prepend_chain(mut q: Query, comb: Combinator, step: Step) -> Query {
	q.chain.insert(0, (comb, step));
	q
}

/// Append a combinator-step pair to the query chain.
fn append_chain(mut q: Query, comb: Combinator, step: Step) -> Query {
	q.chain.push((comb, step));
	q
}

/// Build a context step mirroring the last step's axis/head but with
/// a range predicate `[0..N]`.
fn context_step(last: &Step, n: usize) -> Step {
	Step {
		axis:       last.axis.clone(),
		head:       last.head.clone(),
		predicates: vec![Predicate::Range { start: Some(0), end: Some(n as isize) }],
	}
}

/// Lower projection options into query predicates / combinators.
///
/// The returned query is guaranteed to render and re-parse identically
/// (round-trip invariant).
pub fn lower(opts: ProjectionOpts, query: Query) -> Query {
	let mut q = query;

	// tail takes precedence over limit/head for the predicate shape.
	if let Some(n) = opts.tail {
		q = append_predicate(q, Predicate::Range { start: Some(-(n as isize)), end: None });
		return q;
	}

	let limit = opts.limit.or(opts.head);

	if let Some(n) = limit {
		if let Some(off) = opts.offset {
			q = append_predicate(q, Predicate::Range {
				start: Some(off as isize),
				end:   Some((off + n) as isize),
			});
		} else {
			q = append_predicate(q, Predicate::Range { start: Some(0), end: Some(n as isize) });
		}
	} else if let Some(off) = opts.offset {
		q = append_predicate(q, Predicate::Range { start: Some(off as isize), end: None });
	}

	if let Some(ctx) = opts.context {
		let last = if q.chain.is_empty() {
			q.head.clone()
		} else {
			q.chain[q.chain.len() - 1].1.clone()
		};

		if let Some(n) = ctx.pre {
			let step = context_step(&last, n);
			q = prepend_chain(q, Combinator::PrevSibling, step);
		}

		if let Some(n) = ctx.post {
			let step = context_step(&last, n);
			q = append_chain(q, Combinator::NextSibling, step);
		}
	}

	q
}

#[cfg(test)]
mod tests {
	use winnow::{Parser, token::take_while};

	use super::*;
	use crate::{
		ast::{Head, NamePayload},
		dialect::NameLexer,
		parser::parse_code_path,
		renderer::render_code_path,
	};

	/// Minimal NameLexer that consumes alphanumeric + dots.
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

	/// Round-trip helper: lower -> render -> parse -> render must match.
	fn round_trip_opts(input: &str, opts: ProjectionOpts) {
		let cp = parse_code_path(input, &DotLexer)
			.unwrap_or_else(|d| panic!("parse failed for {input:?}: {d:?}"));
		let q = cp.query.clone().expect("test input must have query");
		let lowered = lower(opts, q);
		let lowered_cp = crate::ast::CodePath {
			locator:   cp.locator.clone(),
			query:     Some(lowered),
			qualifier: cp.qualifier.clone(),
		};
		let rendered = render_code_path(&lowered_cp, &DotLexer);
		let cp2 = parse_code_path(&rendered, &DotLexer)
			.unwrap_or_else(|d| panic!("re-parse failed for {rendered:?}: {d:?}"));
		let rendered2 = render_code_path(&cp2, &DotLexer);
		assert_eq!(rendered, rendered2, "round-trip mismatch: {rendered:?} vs {rendered2:?}");
	}

	#[test]
	fn empty_opts_unchanged() {
		let cp = parse_code_path("src/a.ts :: Foo", &DotLexer).unwrap();
		let q = cp.query.unwrap();
		let lowered = lower(ProjectionOpts::default(), q.clone());
		assert_eq!(lowered, q);
	}

	#[test]
	fn limit_appends_range() {
		round_trip_opts("src/a.ts :: Foo", ProjectionOpts { limit: Some(5), ..Default::default() });
	}

	#[test]
	fn head_alias_appends_range() {
		round_trip_opts("src/a.ts :: Foo", ProjectionOpts { head: Some(3), ..Default::default() });
	}

	#[test]
	fn tail_appends_negative_range() {
		round_trip_opts("src/a.ts :: Foo", ProjectionOpts { tail: Some(5), ..Default::default() });
	}

	#[test]
	fn offset_with_limit_appends_range() {
		round_trip_opts("src/a.ts :: Foo", ProjectionOpts {
			offset: Some(10),
			limit: Some(5),
			..Default::default()
		});
	}

	#[test]
	fn offset_alone_appends_range() {
		round_trip_opts("src/a.ts :: Foo", ProjectionOpts { offset: Some(10), ..Default::default() });
	}

	#[test]
	fn context_post_appends_next_sibling() {
		round_trip_opts("src/a.ts :: §line", ProjectionOpts {
			context: Some(ContextOpts { pre: None, post: Some(3) }),
			..Default::default()
		});
	}

	#[test]
	fn context_pre_prepends_prev_sibling() {
		round_trip_opts("src/a.ts :: §line", ProjectionOpts {
			context: Some(ContextOpts { pre: Some(2), post: None }),
			..Default::default()
		});
	}

	#[test]
	fn context_both_sides() {
		round_trip_opts("src/a.ts :: §line", ProjectionOpts {
			context: Some(ContextOpts { pre: Some(2), post: Some(3) }),
			..Default::default()
		});
	}

	#[test]
	fn limit_on_chained_query() {
		round_trip_opts("src/a.ts :: Foo//§call", ProjectionOpts {
			limit: Some(5),
			..Default::default()
		});
	}

	#[test]
	fn tail_on_chained_query() {
		round_trip_opts("src/a.ts :: Foo//§call", ProjectionOpts {
			tail: Some(5),
			..Default::default()
		});
	}

	#[test]
	fn context_on_chained_query() {
		round_trip_opts("src/a.ts :: §line//§call", ProjectionOpts {
			context: Some(ContextOpts { pre: Some(1), post: Some(2) }),
			..Default::default()
		});
	}

	#[test]
	fn combined_limit_and_context() {
		round_trip_opts("src/a.ts :: §line", ProjectionOpts {
			limit: Some(10),
			context: Some(ContextOpts { pre: Some(2), post: Some(3) }),
			..Default::default()
		});
	}
}
