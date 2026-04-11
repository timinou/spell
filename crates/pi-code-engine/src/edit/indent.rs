use tree_sitter::Node;

#[allow(dead_code, reason = "indent helpers are part of the edit surface but not all are wired yet")]
pub fn line_indent(source: &str, byte_offset_of_line_start: usize) -> usize {
    source[byte_offset_of_line_start..]
        .chars()
        .take_while(|ch| *ch == ' ' || *ch == '\t')
        .map(char::len_utf8)
        .sum()
}

#[allow(dead_code, reason = "indent helpers are part of the edit surface but not all are wired yet")]
pub fn node_indent(source: &str, node: Node<'_>) -> usize {
    let start = node.start_byte();
    let line_start = source[..start].rfind('\n').map_or(0, |idx| idx + 1);
    line_indent(source, line_start)
}

#[allow(dead_code, reason = "indent helpers are part of the edit surface but not all are wired yet")]
pub fn adjust_indent(text: &str, original_col: usize, target_col: usize) -> String {
    let mut out = String::new();
    let delta = target_col.saturating_sub(original_col);
    let pad = " ".repeat(delta);
    for (idx, line) in text.lines().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        if idx == 0 || line.trim().is_empty() {
            out.push_str(line);
        } else {
            out.push_str(&pad);
            out.push_str(line.trim_start());
        }
    }
    out
}
