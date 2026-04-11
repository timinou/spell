use tree_sitter::Node;

pub fn line_indent(source: &str, byte_offset_of_line_start: usize) -> usize {
	source[byte_offset_of_line_start..]
		.chars()
		.take_while(|ch| *ch == ' ' || *ch == '\t')
		.map(char::len_utf8)
		.sum()
}

pub fn node_indent(source: &str, node: Node<'_>) -> usize {
	let start = node.start_byte();
	let line_start = source[..start].rfind('\n').map_or(0, |idx| idx + 1);
	line_indent(source, line_start)
}

pub fn adjust_indent(text: &str, original_col: usize, target_col: usize) -> String {
	let mut out = String::with_capacity(text.len());
	for (idx, line) in text.lines().enumerate() {
		if idx > 0 {
			out.push('\n');
		}
		if idx == 0 || line.trim().is_empty() {
			out.push_str(line);
		} else if target_col >= original_col {
			// Indent: add spaces
			let pad = " ".repeat(target_col - original_col);
			out.push_str(&pad);
			out.push_str(line);
		} else {
			// Dedent: strip leading whitespace up to the delta (never strips content)
			let strip = original_col - target_col;
			let leading = line.len() - line.trim_start().len();
			let actual_strip = strip.min(leading);
			out.push_str(&line[actual_strip..]);
		}
	}
	out
}
