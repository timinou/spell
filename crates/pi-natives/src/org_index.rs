use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	fs,
	path::{Path, PathBuf},
};

use pi_org_engine::{
	OrgItem,
	clock::ClockEntry,
	edge::EdgeKind,
	extract_items_from_source,
	query::{self, QueryFilter},
};
use pi_workspace_cache::{
	CacheStatus, CacheStore, PersistentCacheEntry, WorkspaceFingerprint, read_git_head,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const CACHE_NAME: &str = "workspace";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgCategoryInput {
	pub abs_path: PathBuf,
	pub name:     String,
	pub dir:      String,
	pub prefix:   String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgIndex {
	pub root:            PathBuf,
	pub generated_at_ms: u64,
	pub items:           Vec<PersistedOrgItem>,
	pub duplicate_ids:   BTreeMap<String, Vec<OrgIndexLocation>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedOrgItem {
	pub id:         String,
	pub title:      String,
	pub state:      String,
	pub category:   String,
	pub dir:        String,
	pub file:       String,
	pub line:       usize,
	pub level:      usize,
	pub properties: HashMap<String, String>,
	pub body:       Option<String>,
	pub clocks:     Vec<ClockEntry>,
	pub byte_range: (usize, usize),
	pub children:   Vec<Self>,
	/// Typed edges from the `:RELATIONS:` drawer (FEAT-631). Persisted as
	/// `(token, target_id)` rather than `(EdgeKind, target_id)` because
	/// `EdgeKind`'s serde repr (`tag = "kind", content = "value"`) requires
	/// `deserialize_identifier`, which bincode does not support. We round
	/// trip through `EdgeKind::token()` / `EdgeKind::parse()` in the From
	/// impls; both are total functions (unknown tokens become
	/// `EdgeKind::Other`). Defaulted on deserialize so older cache files
	/// without this field remain loadable.
	#[serde(default)]
	pub relations:  Vec<(String, String)>,
}

impl From<OrgItem> for PersistedOrgItem {
	fn from(value: OrgItem) -> Self {
		Self {
			id:         value.id,
			title:      value.title,
			state:      value.state,
			category:   value.category,
			dir:        value.dir,
			file:       value.file,
			line:       value.line,
			level:      value.level,
			properties: value.properties,
			body:       value.body,
			clocks:     value.clocks,
			byte_range: value.byte_range,
			children:   value.children.into_iter().map(Self::from).collect(),
			relations:  value
				.relations
				.into_iter()
				.map(|(kind, target)| (kind.token(), target))
				.collect(),
		}
	}
}

impl From<PersistedOrgItem> for OrgItem {
	fn from(value: PersistedOrgItem) -> Self {
		Self {
			id:         value.id,
			title:      value.title,
			state:      value.state,
			category:   value.category,
			dir:        value.dir,
			relations:  value
				.relations
				.into_iter()
				.map(|(token, target)| (EdgeKind::parse(&token), target))
				.collect(),
			file:       value.file,
			line:       value.line,
			level:      value.level,
			properties: value.properties,
			body:       value.body,
			clocks:     value.clocks,
			byte_range: value.byte_range,
			children:   value.children.into_iter().map(Self::from).collect(),
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrgIndexLocation {
	pub file:     String,
	pub line:     usize,
	pub category: String,
	pub dir:      String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgIndexEntry {
	pub index:       OrgIndex,
	pub fingerprint: WorkspaceFingerprint,
}

impl PersistentCacheEntry for OrgIndexEntry {
	fn fingerprint(&self) -> &WorkspaceFingerprint {
		&self.fingerprint
	}
}

impl OrgIndexEntry {
	pub const fn new(index: OrgIndex, fingerprint: WorkspaceFingerprint) -> Self {
		Self { index, fingerprint }
	}
}

pub fn parse_categories(options: &Value) -> Result<Vec<OrgCategoryInput>, String> {
	let raw = options
		.get("categories")
		.and_then(Value::as_array)
		.ok_or_else(|| "Missing required field: categories".to_string())?;
	raw.iter()
		.map(|value| {
			let abs_path = value
				.get("absPath")
				.and_then(Value::as_str)
				.ok_or_else(|| "Category missing absPath".to_string())?;
			let name = value
				.get("name")
				.and_then(Value::as_str)
				.ok_or_else(|| "Category missing name".to_string())?;
			let dir = value
				.get("dir")
				.and_then(Value::as_str)
				.ok_or_else(|| "Category missing dir".to_string())?;
			let prefix = value.get("prefix").and_then(Value::as_str).unwrap_or(name);
			Ok(OrgCategoryInput {
				abs_path: PathBuf::from(abs_path),
				name:     name.to_string(),
				dir:      dir.to_string(),
				prefix:   prefix.to_string(),
			})
		})
		.collect()
}

pub fn todo_keywords(options: &Value) -> Vec<&str> {
	options
		.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default()
}

pub fn cache_store(root: &Path) -> CacheStore {
	CacheStore::new(root.join(".spell/org"))
}

pub fn org_source(path: &Path) -> bool {
	path.extension().and_then(|extension| extension.to_str()) == Some("org")
		&& path.file_name().and_then(|name| name.to_str()) != Some("reference.org")
}

pub fn cache_status(root: &Path) -> Result<CacheStatus, String> {
	cache_store(root)
		.status::<OrgIndexEntry>(CACHE_NAME, root, &org_source)
		.map_err(|error| error.to_string())
}

pub fn load(root: &Path) -> Result<Option<OrgIndexEntry>, String> {
	cache_store(root)
		.load::<OrgIndexEntry>(CACHE_NAME)
		.map_err(|error| error.to_string())
}

pub fn save(root: &Path, entry: &OrgIndexEntry) -> Result<(), String> {
	cache_store(root)
		.save(CACHE_NAME, entry)
		.map_err(|error| error.to_string())
}

pub fn ensure_fresh(
	root: &Path,
	categories: &[OrgCategoryInput],
	todo_keywords: &[&str],
	force_rebuild: bool,
) -> Result<(OrgIndexEntry, CacheStatus, bool), String> {
	let status = cache_status(root)?;
	if !force_rebuild
		&& status == CacheStatus::Fresh
		&& let Some(entry) = load(root)?
	{
		return Ok((entry, status, false));
	}
	let entry = build(root, categories, todo_keywords)?;
	save(root, &entry)?;
	Ok((entry, status, true))
}

pub fn build(
	root: &Path,
	categories: &[OrgCategoryInput],
	todo_keywords: &[&str],
) -> Result<OrgIndexEntry, String> {
	let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
	if !root.is_dir() {
		return Err(format!("invalid org index root {}", root.display()));
	}
	let mut items = Vec::new();
	for category in categories {
		let entries = match fs::read_dir(&category.abs_path) {
			Ok(entries) => entries,
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
			Err(error) => return Err(error.to_string()),
		};
		let mut files = entries
			.filter_map(Result::ok)
			.map(|entry| entry.path())
			.filter(|path| org_source(path))
			.collect::<Vec<_>>();
		files.sort();
		for file in files {
			let source = fs::read_to_string(&file).map_err(|error| error.to_string())?;
			let parsed = extract_items_from_source(
				&source,
				todo_keywords,
				&category.name,
				&category.dir,
				&file.to_string_lossy(),
				true,
			)
			.map_err(|error| error.to_string())?;
			items.extend(parsed);
		}
	}
	items.sort_by(compare_org_item_location);
	let duplicate_ids = duplicate_id_locations(&items);
	let items = items.into_iter().map(PersistedOrgItem::from).collect();
	let fingerprint = pi_workspace_cache::fingerprint_root(&root, &org_source)
		.map_err(|error| error.to_string())?;
	let index = OrgIndex { root, generated_at_ms: now_ms(), items, duplicate_ids };
	Ok(OrgIndexEntry::new(index, fingerprint))
}

pub fn resolve(entry: &OrgIndexEntry, id: &str, include_body: bool) -> Vec<OrgItem> {
	entry
		.index
		.items
		.iter()
		.map(|item| OrgItem::from(item.clone()))
		.filter(|item| item.id == id)
		.map(|mut item| {
			if !include_body {
				strip_body(&mut item);
			}
			item
		})
		.collect()
}

pub fn list(
	entry: &OrgIndexEntry,
	filter: &QueryFilter,
	include_body: bool,
) -> (Vec<OrgItem>, usize) {
	let mut query_filter = filter.clone();
	query_filter.include_body = include_body;
	let org_items = entry
		.index
		.items
		.iter()
		.map(|item| OrgItem::from(item.clone()))
		.collect::<Vec<_>>();
	let mut refs = query::apply_filter(&org_items, &query_filter);
	query::sort_items(&mut refs, query_filter.sort.as_deref());
	let total = refs.len();
	let page = query::paginate(refs, query_filter.offset, query_filter.limit);
	let items = page
		.into_iter()
		.cloned()
		.map(|mut item| {
			if !include_body {
				strip_body(&mut item);
			}
			item
		})
		.collect();
	(items, total)
}

pub fn dashboard(
	entry: &OrgIndexEntry,
	categories: &[OrgCategoryInput],
	todo_keywords: &[&str],
) -> Value {
	let mut totals = serde_json::Map::new();
	for keyword in todo_keywords {
		totals.insert((*keyword).to_string(), json!(0));
	}
	let mut category_outputs = Vec::new();
	let mut in_progress = Vec::new();
	let mut blocked = Vec::new();
	for category in categories {
		let top_level = entry
			.index
			.items
			.iter()
			.map(|item| OrgItem::from(item.clone()))
			.filter(|item| item.level == 0)
			.filter(|item| item.category == category.name)
			.filter(|item| item.dir == category.dir)
			.collect::<Vec<_>>();
		let mut by_state: BTreeMap<String, usize> = BTreeMap::new();
		for item in &top_level {
			*by_state.entry(item.state.clone()).or_default() += 1;
			let current = totals.get(&item.state).and_then(Value::as_u64).unwrap_or(0);
			totals.insert(item.state.clone(), json!(current + 1));
			if item.state == "DOING" || item.state == "REVIEW" {
				in_progress.push((*item).clone());
			}
			if item.state == "BLOCKED" {
				blocked.push((*item).clone());
			}
		}
		category_outputs.push(json!({
			 "category": category.name,
			"prefix": category.prefix,
			 "total": top_level.len(),
			 "byState": by_state,
		}));
	}
	json!({
		 "root": entry.index.root.display().to_string(),
		 "categories": category_outputs,
		 "totals": totals,
		 "inProgress": in_progress,
		 "blocked": blocked,
	})
}

pub fn archive_items(entry: &OrgIndexEntry, category: Option<&str>) -> Vec<Value> {
	entry
		.index
		.items
		.iter()
		.map(|item| OrgItem::from(item.clone()))
		.filter(|item| item.level == 0)
		.filter(|item| item.state == "DONE")
		.filter(|item| category.is_none_or(|category| item.category == category))
		.map(|item| json!({ "id": item.id, "file": item.file }))
		.collect()
}

pub fn validate_plan(entry: &OrgIndexEntry, plan_id: &str) -> Value {
	let plans = resolve(entry, plan_id, true);
	let Some(plan) = plans.first() else {
		return json!({
			 "valid": false,
			 "issues": [{ "severity": "error", "code": "PLAN_NOT_FOUND", "message": format!("Plan item not found: {plan_id}") }],
			 "resolvedChildren": [],
			 "planItem": Value::Null,
		});
	};
	let linked_ids = extract_id_links(plan.body.as_deref().unwrap_or_default());
	let mut issues = Vec::new();
	let mut resolved = Vec::new();
	let mut seen = BTreeSet::new();
	for id in linked_ids {
		if !seen.insert(id.clone()) {
			continue;
		}
		let matches = resolve(entry, &id, true);
		if matches.is_empty() {
			issues.push(json!({ "severity": "error", "code": "MISSING_LINKED_ITEM", "message": format!("Linked item not found: {id}"), "id": id }));
		} else {
			resolved.extend(matches);
		}
	}
	for (id, locations) in &entry.index.duplicate_ids {
		if id == plan_id || seen.contains(id) {
			issues.push(json!({ "severity": "error", "code": "DUPLICATE_CUSTOM_ID", "message": format!("Duplicate CUSTOM_ID: {id}"), "id": id, "locations": locations }));
		}
	}
	json!({
		 "valid": issues.is_empty(),
		 "issues": issues,
		 "resolvedChildren": resolved,
		 "planItem": plan,
		 "duplicateIds": entry.index.duplicate_ids,
	})
}

pub fn status_json(root: &Path) -> Value {
	let status = match cache_status(root) {
		Ok(CacheStatus::Missing) => json!({ "status": "missing" }),
		Ok(CacheStatus::Fresh) => json!({ "status": "fresh" }),
		Ok(CacheStatus::Stale { reason }) => json!({ "status": "stale", "reason": reason }),
		Err(error) => json!({ "status": "error", "reason": error }),
	};
	let loaded = load(root).ok().flatten();
	json!({
		 "cache": status,
		 "itemCount": loaded.as_ref().map_or(0, |entry| entry.index.items.len()),
		 "duplicateIds": loaded.map_or_else(BTreeMap::new, |entry| entry.index.duplicate_ids),
	})
}

pub fn compare_org_item_location(a: &OrgItem, b: &OrgItem) -> std::cmp::Ordering {
	a.file
		.cmp(&b.file)
		.then(a.line.cmp(&b.line))
		.then(a.id.cmp(&b.id))
}

fn duplicate_id_locations(items: &[OrgItem]) -> BTreeMap<String, Vec<OrgIndexLocation>> {
	let mut by_id: HashMap<String, Vec<OrgIndexLocation>> = HashMap::new();
	for item in items {
		if item.id.is_empty() {
			continue;
		}
		by_id
			.entry(item.id.clone())
			.or_default()
			.push(OrgIndexLocation {
				file:     item.file.clone(),
				line:     item.line,
				category: item.category.clone(),
				dir:      item.dir.clone(),
			});
	}
	by_id
		.into_iter()
		.filter(|(_, locations)| locations.len() > 1)
		.collect()
}

fn strip_body(item: &mut OrgItem) {
	item.body = None;
	for child in &mut item.children {
		strip_body(child);
	}
}

fn extract_id_links(body: &str) -> Vec<String> {
	let mut ids = Vec::new();
	for segment in body.split("[[id:").skip(1) {
		if let Some((id, _)) = segment.split_once(']') {
			let trimmed = id.trim();
			if !trimmed.is_empty() {
				ids.push(trimmed.to_string());
			}
		}
	}
	ids
}

fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64
}

pub fn fingerprint_hash(entry: &OrgIndexEntry) -> u64 {
	use std::hash::{Hash, Hasher};
	let mut hasher = std::collections::hash_map::DefaultHasher::new();
	entry.fingerprint.hash(&mut hasher);
	hasher.finish()
}

pub fn git_head(root: &Path) -> Option<String> {
	read_git_head(root)
}
