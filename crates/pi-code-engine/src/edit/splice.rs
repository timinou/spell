use super::{
	TextEdit,
	indent::{adjust_indent, node_indent},
	node_at_line, node_text,
	replace::standalone_sibling_boundary,
};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

#[derive(Debug, Clone, Copy)]
pub enum SpliceMode {
	Up,
	Self_,
	Down,
}

pub fn splice_node(
	buffer: &CodeBuffer,
	line: usize,
	mode: SpliceMode,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let node = node_at_line(buffer, line, within)?;
	let parent = node
		.parent()
		.ok_or_else(|| CodeEngineError::Edit(format!("No parent node at line {line}")))?;

	let parent_indent = node_indent(&source, parent);
	let node_indent_col = node_indent(&source, node);

	let mut cursor = parent.walk();
	let mut kept = String::new();
	let mut first = true;
	for child in parent.named_children(&mut cursor) {
		let keep = match mode {
			SpliceMode::Up => child.start_byte() >= node.start_byte(),
			SpliceMode::Self_ => {
				child.start_byte() >= node.start_byte() && child.end_byte() <= node.end_byte()
			},
			SpliceMode::Down => child.end_byte() <= node.end_byte(),
		};
		if keep {
			standalone_sibling_boundary(
				&source,
				child.start_byte(),
				child.end_byte(),
				child.start_position().row + 1,
				"splice",
			)?;
			if !first {
				kept.push('\n');
			}
			first = false;
			kept.push_str(&node_text(buffer, child));
		}
	}

	let adjusted = adjust_indent(&kept, node_indent_col, parent_indent);

	Ok(vec![TextEdit {
		start_byte:   parent.start_byte(),
		old_end_byte: parent.end_byte(),
		new_text:     adjusted,
	}])
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::{
		buffer::CodeBuffer,
		language::{LanguageId, LanguageRegistry},
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	#[test]
	fn splice_node_rejects_shared_boundary_siblings() {
		let source = "const alpha = 1; const beta = 2;\n";
		let buffer = ts_buffer(source);
		let err = splice_node(&buffer, 1, SpliceMode::Self_, None)
			.expect_err("shared boundary should refuse");
		assert!(err.to_string().contains("Unsafe splice"));
	}
}
