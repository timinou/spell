//! Tests for multi-root locate: cwd vs personal scope, shadowing, and iteration.
//!
//! Each test builds temporary dir trees with `.org` fixtures and runs
//! `MultiRootIndex::build` then exercises `resolve` / `iter`.

use std::path::Path;

use pi_org_engine::{locate::MultiRootIndex, locate::RootScope};

const TODO: &[&str] = &["ITEM", "DOING", "DONE"];

/// Write an org file at `dir/name` with a heading carrying `custom_id`.
fn write_org_fixture(dir: &Path, name: &str, custom_id: &str) {
	let src = format!(
		"* ITEM {name}\n:PROPERTIES:\n:CUSTOM_ID: {custom_id}\n:END:\n"
	);
	std::fs::write(dir.join(name), &src).unwrap();
}

// ── 1: Resolve id in personal when absent from cwd ─────────────────────────

#[test]
fn resolves_id_in_personal_when_absent_in_cwd() {
	let cwd = tempfile::tempdir().unwrap();
	let personal = tempfile::tempdir().unwrap();

	// Only personal has CON-x
	write_org_fixture(personal.path(), "concept.org", "CON-x");

	let idx = MultiRootIndex::build(
		&[(RootScope::Cwd, cwd.path()), (RootScope::Personal, personal.path())],
		TODO,
	);

	let result = idx.resolve("CON-x");
	assert!(result.is_some(), "CON-x should resolve");

	let (scope, _path) = result.unwrap();
	assert_eq!(scope, RootScope::Personal, "should resolve from personal");
}

// ── 2: Cwd shadows personal on same id ────────────────────────────────────

#[test]
fn cwd_shadows_personal_on_same_id() {
	let cwd = tempfile::tempdir().unwrap();
	let personal = tempfile::tempdir().unwrap();

	// Both have EP-x
	write_org_fixture(cwd.path(), "ep-1.org", "EP-x");
	write_org_fixture(personal.path(), "ep-personal.org", "EP-x");

	let idx = MultiRootIndex::build(
		&[(RootScope::Cwd, cwd.path()), (RootScope::Personal, personal.path())],
		TODO,
	);

	let result = idx.resolve("EP-x");
	assert!(result.is_some(), "EP-x should resolve");

	let (scope, path) = result.unwrap();
	assert_eq!(scope, RootScope::Cwd, "cwd should shadow personal");
	// Path should be in cwd dir
	assert!(
		path.starts_with(cwd.path()),
		"path {:?} should be under cwd {:?}",
		path,
		cwd.path()
	);
}

// ── 3: Unknown id returns none ────────────────────────────────────────────

#[test]
fn unknown_id_returns_none() {
	let cwd = tempfile::tempdir().unwrap();
	let personal = tempfile::tempdir().unwrap();

	write_org_fixture(cwd.path(), "ep-1.org", "EP-x");

	let idx = MultiRootIndex::build(
		&[(RootScope::Cwd, cwd.path()), (RootScope::Personal, personal.path())],
		TODO,
	);

	assert!(idx.resolve("NONEXISTENT").is_none(), "unknown id should be none");
}

// ── 4: Iter yields all known ids ──────────────────────────────────────────

#[test]
fn iter_yields_all_known_ids_with_scope_tag() {
	let cwd = tempfile::tempdir().unwrap();
	let personal = tempfile::tempdir().unwrap();

	write_org_fixture(cwd.path(), "ep-1.org", "EP-a");
	write_org_fixture(cwd.path(), "ep-2.org", "EP-b");
	write_org_fixture(personal.path(), "con-1.org", "CON-z");

	let idx = MultiRootIndex::build(
		&[(RootScope::Cwd, cwd.path()), (RootScope::Personal, personal.path())],
		TODO,
	);

	let collected: Vec<(RootScope, String)> = idx
		.iter()
		.map(|(scope, id, _path)| (scope, id.clone()))
		.collect();

	assert_eq!(collected.len(), 3, "should yield all 3 ids");

	// EP-a and EP-b should carry Cwd scope
	assert!(collected.contains(&(RootScope::Cwd, "EP-a".into())), "EP-a with Cwd");
	assert!(collected.contains(&(RootScope::Cwd, "EP-b".into())), "EP-b with Cwd");
	// CON-z should carry Personal scope
	assert!(
		collected.contains(&(RootScope::Personal, "CON-z".into())),
		"CON-z with Personal"
	);
}
