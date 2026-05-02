//! Native query engine — replaces org-ql.
//!
//! Supports the keyword query syntax: `todo:DOING tags:auth priority:>=B`
//! and structural filters for programmatic use.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::{effort::Effort, item::OrgItem};

/// A parsed query filter.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryFilter {
	/// Filter by TODO state(s).
	#[serde(default)]
	pub todo:         Vec<String>,
	/// Filter by priority with comparison op.
	pub priority:     Option<PriorityFilter>,
	/// Filter by property equality.
	#[serde(default)]
	pub properties:   Vec<PropertyFilter>,
	/// Filter by LAYER property.
	pub layer:        Option<String>,
	/// Filter by AGENT property.
	pub agent:        Option<String>,
	/// Filter by category.
	#[serde(default)]
	pub category:     Vec<String>,
	/// Filter by dir.
	#[serde(default)]
	pub dir:          Vec<String>,
	/// Filter by heading level. 0 = file-level only.
	pub level:        Option<usize>,
	/// Effort comparison filter.
	pub effort:       Option<EffortFilter>,
	/// Text/regex search in body or title.
	pub text:         Option<String>,
	/// Sort key(s), space-separated.
	pub sort:         Option<String>,
	/// Maximum results.
	pub limit:        Option<usize>,
	/// Skip first N results.
	pub offset:       Option<usize>,
	/// Include body in results.
	#[serde(default)]
	pub include_body: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriorityFilter {
	pub op:    CompareOp,
	pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyFilter {
	pub key:   String,
	pub value: String,
	#[serde(default)]
	pub op:    CompareOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffortFilter {
	pub op:      CompareOp,
	pub minutes: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompareOp {
	#[default]
	Eq,
	Gte,
	Lte,
	Gt,
	Lt,
}

impl CompareOp {
	fn matches(self, ordering: Ordering) -> bool {
		match self {
			Self::Eq => ordering == Ordering::Equal,
			Self::Gte => ordering != Ordering::Less,
			Self::Lte => ordering != Ordering::Greater,
			Self::Gt => ordering == Ordering::Greater,
			Self::Lt => ordering == Ordering::Less,
		}
	}
}

/// Parse the keyword query syntax into a `QueryFilter`.
///
/// Format: `todo:DOING,REVIEW priority:>=B layer:frontend property:KEY=VALUE
/// effort:>=2h`
pub fn parse_keyword_query(input: &str) -> QueryFilter {
	let mut filter = QueryFilter::default();
	let tokens: Vec<&str> = input.split_whitespace().collect();

	for token in tokens {
		if let Some(val) = token.strip_prefix("todo:") {
			filter.todo = val
				.split(',')
				.filter(|s| !s.is_empty())
				.map(String::from)
				.collect();
		} else if let Some(val) = token.strip_prefix("priority:") {
			filter.priority = parse_priority_filter(val);
		} else if let Some(val) = token.strip_prefix("layer:") {
			filter.layer = Some(val.to_string());
		} else if let Some(val) = token.strip_prefix("agent:") {
			filter.agent = Some(val.to_string());
		} else if let Some(val) = token.strip_prefix("category:") {
			filter.category = val
				.split(',')
				.filter(|s| !s.is_empty())
				.map(String::from)
				.collect();
		} else if let Some(val) = token.strip_prefix("dir:") {
			filter.dir = val
				.split(',')
				.filter(|s| !s.is_empty())
				.map(String::from)
				.collect();
		} else if let Some(val) = token.strip_prefix("property:") {
			if let Some(pf) = parse_property_filter(val) {
				filter.properties.push(pf);
			}
		} else if let Some(val) = token.strip_prefix("effort:") {
			filter.effort = parse_effort_filter(val);
		} else if let Some(val) = token.strip_prefix("level:") {
			filter.level = val.parse().ok();
		} else if let Some(val) = token.strip_prefix("text:") {
			filter.text = Some(val.to_string());
		}
	}

	filter
}

fn parse_priority_filter(val: &str) -> Option<PriorityFilter> {
	let (op, value) = if let Some(v) = val.strip_prefix(">=") {
		(CompareOp::Gte, v)
	} else if let Some(v) = val.strip_prefix("<=") {
		(CompareOp::Lte, v)
	} else if let Some(v) = val.strip_prefix('>') {
		(CompareOp::Gt, v)
	} else if let Some(v) = val.strip_prefix('<') {
		(CompareOp::Lt, v)
	} else if let Some(v) = val.strip_prefix('=') {
		(CompareOp::Eq, v)
	} else {
		(CompareOp::Eq, val)
	};
	if value.is_empty() {
		return None;
	}
	Some(PriorityFilter { op, value: value.trim_start_matches('#').to_string() })
}

fn parse_property_filter(val: &str) -> Option<PropertyFilter> {
	let (key, value) = val.split_once('=')?;
	Some(PropertyFilter { key: key.to_string(), value: value.to_string(), op: CompareOp::Eq })
}

fn parse_effort_filter(val: &str) -> Option<EffortFilter> {
	let (op, effort_str) = if let Some(v) = val.strip_prefix(">=") {
		(CompareOp::Gte, v)
	} else if let Some(v) = val.strip_prefix("<=") {
		(CompareOp::Lte, v)
	} else if let Some(v) = val.strip_prefix('>') {
		(CompareOp::Gt, v)
	} else if let Some(v) = val.strip_prefix('<') {
		(CompareOp::Lt, v)
	} else if let Some(v) = val.strip_prefix('=') {
		(CompareOp::Eq, v)
	} else {
		(CompareOp::Eq, val)
	};
	let effort = Effort::parse(effort_str)?;
	Some(EffortFilter { op, minutes: effort.0 })
}

/// Apply a filter to a list of items, returning only matching ones.
pub fn apply_filter<'a>(items: &'a [OrgItem], filter: &QueryFilter) -> Vec<&'a OrgItem> {
	items
		.iter()
		.filter(|item| matches_filter(item, filter))
		.collect()
}

/// Check if a single item matches the filter.
pub fn matches_filter(item: &OrgItem, filter: &QueryFilter) -> bool {
	// TODO state filter
	if !filter.todo.is_empty() && !filter.todo.contains(&item.state) {
		return false;
	}

	// Priority filter
	if let Some(pf) = &filter.priority {
		let item_priority = item.priority().unwrap_or("C"); // default lowest
		let cmp = compare_priority(item_priority, &pf.value);
		if !pf.op.matches(cmp) {
			return false;
		}
	}

	// Layer filter
	if let Some(layer) = &filter.layer
		&& item.layer() != Some(layer.as_str())
	{
		return false;
	}

	// Agent filter
	if let Some(agent) = &filter.agent
		&& item.agent() != Some(agent.as_str())
	{
		return false;
	}

	// Category filter
	if !filter.category.is_empty() && !filter.category.contains(&item.category) {
		return false;
	}

	// Dir filter
	if !filter.dir.is_empty() && !filter.dir.contains(&item.dir) {
		return false;
	}

	// Level filter
	if let Some(level) = filter.level
		&& item.level != level
	{
		return false;
	}

	// Property filters
	for pf in &filter.properties {
		let item_val = item.property(&pf.key).unwrap_or("");
		if item_val != pf.value {
			return false;
		}
	}

	// Effort filter
	if let Some(ef) = &filter.effort {
		let item_effort = item
			.property("EFFORT")
			.and_then(Effort::parse)
			.map_or(0, |effort| effort.0);
		let cmp = item_effort.cmp(&ef.minutes);
		if !ef.op.matches(cmp) {
			return false;
		}
	}

	// Text search (simple substring match)
	if let Some(text) = &filter.text {
		let text_lower = text.to_lowercase();
		let in_title = item.title.to_lowercase().contains(&text_lower);
		let in_body = item
			.body
			.as_ref()
			.is_some_and(|b| b.to_lowercase().contains(&text_lower));
		if !in_title && !in_body {
			return false;
		}
	}

	true
}

/// Compare two priority values. A > B > C (A is highest).
/// Returns Ordering where Greater means higher priority.
fn compare_priority(a: &str, b: &str) -> Ordering {
	let a_rank = priority_rank(a);
	let b_rank = priority_rank(b);
	// Reverse: lower rank = higher priority
	b_rank.cmp(&a_rank)
}

/// Lower rank = higher priority (A=0, B=1, C=2).
fn priority_rank(p: &str) -> u8 {
	match p.trim_start_matches('#') {
		"A" => 0,
		"B" => 1,
		"C" => 2,
		_ => 3,
	}
}

/// Sort items by the given sort specification.
///
/// Sort keys (space-separated): `priority`, `state`/`todo`, `id`, `category`.
/// Default: `priority state id`.
pub fn sort_items(items: &mut Vec<&OrgItem>, sort_spec: Option<&str>) {
	let spec = sort_spec.unwrap_or("priority state id");
	let keys: Vec<&str> = spec.split_whitespace().collect();

	items.sort_by(|a, b| {
		for key in &keys {
			let ord = match *key {
				"priority" => {
					let ap = priority_rank(a.priority().unwrap_or("C"));
					let bp = priority_rank(b.priority().unwrap_or("C"));
					ap.cmp(&bp)
				},
				"state" | "todo" => a.state.cmp(&b.state),
				"id" => a.id.cmp(&b.id),
				"category" => a.category.cmp(&b.category),
				_ => Ordering::Equal,
			};
			if ord != Ordering::Equal {
				return ord;
			}
		}
		Ordering::Equal
	});
}

/// Apply pagination (offset + limit) to a result set.
pub fn paginate(
	items: Vec<&OrgItem>,
	offset: Option<usize>,
	limit: Option<usize>,
) -> Vec<&OrgItem> {
	let start = offset.unwrap_or(0);
	let iter = items.into_iter().skip(start);
	if let Some(limit) = limit {
		iter.take(limit).collect()
	} else {
		iter.collect()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_keyword_query_basic() {
		let filter = parse_keyword_query("todo:DOING priority:>=B");
		assert_eq!(filter.todo, vec!["DOING"]);
		let pf = filter.priority.unwrap();
		assert_eq!(pf.op, CompareOp::Gte);
		assert_eq!(pf.value, "B");
	}

	#[test]
	fn parse_keyword_query_effort() {
		let filter = parse_keyword_query("effort:>=2h");
		let ef = filter.effort.unwrap();
		assert_eq!(ef.op, CompareOp::Gte);
		assert_eq!(ef.minutes, 120);
	}

	#[test]
	fn priority_comparison() {
		assert_eq!(compare_priority("A", "B"), Ordering::Greater); // A is higher priority
		assert_eq!(compare_priority("B", "A"), Ordering::Less);
		assert_eq!(compare_priority("A", "A"), Ordering::Equal);
	}

	#[test]
	fn filter_by_state() {
		let items = vec![
			make_item("T-1", "DOING", "A"),
			make_item("T-2", "ITEM", "B"),
			make_item("T-3", "DOING", "C"),
		];
		let filter = QueryFilter { todo: vec!["DOING".into()], ..Default::default() };
		let result = apply_filter(&items, &filter);
		assert_eq!(result.len(), 2);
	}

	#[test]
	fn filter_by_priority_gte() {
		let items = vec![
			make_item("T-1", "DOING", "A"),
			make_item("T-2", "DOING", "B"),
			make_item("T-3", "DOING", "C"),
		];
		let filter = QueryFilter {
			priority: Some(PriorityFilter { op: CompareOp::Gte, value: "B".into() }),
			..Default::default()
		};
		let result = apply_filter(&items, &filter);
		// A and B have rank <= B's rank, so they match >=B
		assert_eq!(result.len(), 2);
		assert_eq!(result[0].id, "T-1");
		assert_eq!(result[1].id, "T-2");
	}

	fn make_item(id: &str, state: &str, priority: &str) -> OrgItem {
		let mut properties = std::collections::HashMap::new();
		properties.insert("CUSTOM_ID".to_string(), id.to_string());
		properties.insert("PRIORITY".to_string(), format!("#{priority}"));
		OrgItem {
			id: id.to_string(),
			title: format!("Task {id}"),
			state: state.to_string(),
			category: "test".to_string(),
			dir: "tasks".to_string(),
			file: "/test.org".to_string(),
			line: 1,
			level: 1,
			properties,
			body: None,
			clocks: Vec::new(),
			byte_range: (0, 0),
			children: Vec::new(),
			relations: Vec::new(),
		}
	}
}
