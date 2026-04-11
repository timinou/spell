use super::Mark;

#[derive(Clone, Copy)]
pub enum Target {
	Self_,
	Parent,
	Grandparent,
}

pub struct Selector {
	pub target:       Target,
	pub child_filter: Option<ChildFilter>,
}

pub struct ChildFilter {
	pub discard_types: Vec<String>,
	pub default_mark:  Mark,
}

pub struct SelectorBuilder {
	selector: Selector,
}

pub struct ChildFilterBuilder {
	filter: ChildFilter,
}

impl SelectorBuilder {
	pub(crate) const fn new() -> Self {
		Self { selector: Selector { target: Target::Self_, child_filter: None } }
	}

	pub const fn choose(mut self, target: Target) -> Self {
		self.selector.target = target;
		self
	}

	pub fn match_children<F>(mut self, f: F) -> Self
	where
		F: FnOnce(ChildFilterBuilder) -> ChildFilterBuilder,
	{
		self.selector.child_filter = Some(f(ChildFilterBuilder::new()).build());
		self
	}

	pub(crate) fn build(self) -> Selector {
		self.selector
	}
}

impl ChildFilterBuilder {
	pub(crate) const fn new() -> Self {
		Self { filter: ChildFilter { discard_types: Vec::new(), default_mark: Mark::Match } }
	}

	pub fn discard(mut self, types: &[&str]) -> Self {
		self
			.filter
			.discard_types
			.extend(types.iter().map(|name| (*name).to_string()));
		self
	}

	pub const fn default_mark(mut self, mark: Mark) -> Self {
		self.filter.default_mark = mark;
		self
	}

	pub(crate) fn build(self) -> ChildFilter {
		self.filter
	}
}
