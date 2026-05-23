//! Diagnostic-quality demo: prints all error paths for the 6 declarative
//! schemes. Run with `cargo test -p pi-natives --test show_hints_demo -- --nocapture`.

use pi_code_path::{
	UriLocator, resolver::traits::CancellationToken, scheme::SessionContext,
	scheme_dispatch::SchemeRegistry,
};
use pi_natives::code_path::uri::SCHEME_FACTORIES;

#[test]
fn demo_print_all_diagnostics() {
	let tmp = std::env::temp_dir().join("spell-hintdemo");
	std::fs::create_dir_all(&tmp).ok();
	let ctx = SessionContext::new(&tmp, "/home/u").with_session_dir(&tmp);
	let reg = SchemeRegistry::from_static(SCHEME_FACTORIES.iter().copied(), Some(&ctx));
	let cancel = CancellationToken::new();
	let cases: &[(&str, &str)] = &[
		("agent", ""),
		("agent", "foo/bar"),
		("memory", ""),
		("memory", "notroot"),
		("pi", ""),
		("pi", "README.md"),
		("local", ""),
		("local", "../etc/passwd"),
		("org", ""),
		("org", "BUG-NONEXISTENT"),
		("artifact", ""),
		("artifact", "bogus-id"),
	];
	println!("\n=== Scheme diagnostic preview ===");
	for (scheme, body) in cases {
		let uri = UriLocator { scheme: scheme.to_string(), path: body.to_string() };
		match reg.resolve(&uri, Some(&ctx), &cancel) {
			Ok(_) => println!("  OK    {scheme}://{body}"),
			Err(d) => println!("  ERR   {scheme}://{body}\n        → {}", d.message),
		}
	}
	println!();
}
