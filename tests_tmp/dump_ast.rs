use std::path::Path;

fn dump(node: tree_sitter::Node, src: &str, depth: usize) {
    let indent = "  ".repeat(depth);
    let field = node.parent().and_then(|p| p.field_name_for_child(node.id() as u32)).unwrap_or("-");
    let text = &src[node.start_byte()..node.end_byte().min(src.len())];
    eprintln!("{}{} field={} [{}..{}] | {}", indent, node.kind(), field, node.start_byte(), node.end_byte(), text.replace('\n', "\\n"));
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) { dump(child, src, depth+1); }
}

#[test]
fn dump_ts_ast() {
    let reg = pi_code_engine::language::LanguageRegistry::with_builtins().expect("builtins");
    let profile = reg.match_path(Path::new("test.ts")).expect("profile");
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&profile.ts_language).unwrap();
    let cases = [
        "function handler(x: number): Promise<void> { return x; }",
        "const handler = (x: number): Promise<void> => { return x; };",
        "class Bar { @injectable() method() {} }",
        "const App = () => <div className=\"x\">hello</div>;",
        "export default App;",
        "import { a } from \"a\";\nimport { b } from \"b\";",
        "console.log(1);",
        "useEffect(() => {}, []);",
    ];
    for src in cases {
        eprintln!("\n=== {} ===", src.replace('\n', "\\n"));
        let tree = parser.parse(src, None).unwrap();
        dump(tree.root_node(), src, 0);
    }
    panic!("intentional");
}
