#![allow(
	clippy::suboptimal_flops,
	clippy::uninlined_format_args,
	reason = "SVG layout math and templates prioritize readability over style lints"
)]

use serde::{Deserialize, Serialize};

use crate::session::{
	BlockKind, BlockModel, LayoutBounds, PageMetric, ParsedBlock, SurfaceState, page_gap,
	page_height, page_margin_x, page_margin_y, page_width,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDocument {
	pub svg:    String,
	pub pages:  Vec<PageMetric>,
	pub blocks: Vec<BlockModel>,
}

pub fn render_document(
	parsed_blocks: &[ParsedBlock],
	_viewport: &crate::session::ViewportState,
	_existing_pages: &[PageMetric],
	state: &SurfaceState,
) -> RenderedDocument {
	let mut page = 1u32;
	let mut y = page_margin_y();
	let mut page_blocks = 0u32;
	let mut pages = Vec::new();
	let mut rendered_blocks = Vec::with_capacity(parsed_blocks.len());
	let mut svg_fragments = Vec::with_capacity(parsed_blocks.len() + 8);
	let total_width = page_width();
	let block_width = total_width - (page_margin_x() * 2.0);

	svg_fragments.push(format!(
		"<rect x=\"0\" y=\"0\" width=\"{total_width}\" height=\"{:.1}\" fill=\"#f5f4ef\" />",
		document_height_hint(parsed_blocks.len())
	));

	for parsed in parsed_blocks {
		let height = block_height(parsed, block_width);
		let page_top = page_origin(page);
		if y + height > page_top + page_height() - page_margin_y() {
			pages.push(PageMetric {
				page,
				width: page_width(),
				height: page_height(),
				blocks: page_blocks,
				ready: true,
			});
			page = page.saturating_add(1);
			y = page_origin(page) + page_margin_y();
			page_blocks = 0;
		}
		if page_blocks == 0 {
			svg_fragments.push(format!(
				"<rect x=\"24\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"18\" fill=\"white\" \
				 stroke=\"#d8d5cc\" stroke-width=\"1.5\" />",
				page_origin(page),
				page_width() - 48.0,
				page_height()
			));
		}
		page_blocks = page_blocks.saturating_add(1);
		let bounds = LayoutBounds { page, x: page_margin_x(), y, width: block_width, height };
		rendered_blocks.push(BlockModel {
			anchor:   parsed.anchor.clone(),
			kind:     parsed.kind,
			text:     parsed.text.clone(),
			span:     parsed.span.clone(),
			bounds:   bounds.clone(),
			editable: parsed.editable,
			reason:   parsed.reason,
			level:    parsed.level,
			meta:     parsed.meta.clone(),
		});
		svg_fragments.push(render_block(parsed, &bounds, state.degraded));
		y += height + 14.0;
	}

	pages.push(PageMetric {
		page,
		width: page_width(),
		height: page_height(),
		blocks: page_blocks,
		ready: true,
	});
	let total_height = page_origin(page) + page_height() + 24.0;
	let svg = format!(
		"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{:.1}\" height=\"{:.1}\" viewBox=\"0 0 \
		 {:.1} {:.1}\">{}</svg>",
		total_width,
		total_height,
		total_width,
		total_height,
		svg_fragments.join("")
	);
	RenderedDocument { svg, pages, blocks: rendered_blocks }
}

fn document_height_hint(block_count: usize) -> f32 {
	let approximate_pages = ((block_count.max(1) as f32) / 8.0).ceil();
	page_origin(approximate_pages as u32) + page_height() + 24.0
}

fn page_origin(page: u32) -> f32 {
	24.0 + ((page - 1) as f32 * (page_height() + page_gap()))
}

fn block_height(block: &ParsedBlock, width: f32) -> f32 {
	match block.kind {
		BlockKind::Heading => {
			let level = block.level.unwrap_or(1);
			match level {
				1 => 58.0,
				2 => 48.0,
				_ => 40.0,
			}
		},
		BlockKind::Paragraph => {
			let lines = visual_lines(&block.text, width, 42.0);
			24.0 * lines as f32 + 8.0
		},
		BlockKind::ListItem => {
			let lines = visual_lines(&block.text, width - 36.0, 42.0);
			24.0 * lines as f32 + 6.0
		},
		BlockKind::Image => 196.0,
		BlockKind::Table => {
			let rows = block.lines.len().max(1) as f32;
			rows * 42.0 + 12.0
		},
		BlockKind::Variable => 54.0,
		BlockKind::Unsupported => 74.0,
	}
}

fn visual_lines(text: &str, width: f32, chars_per_line: f32) -> usize {
	let effective_chars = ((width / chars_per_line).floor() as usize).max(18);
	text.chars().count().div_ceil(effective_chars).max(1)
}

fn render_block(block: &ParsedBlock, bounds: &LayoutBounds, degraded: bool) -> String {
	let editable = if block.editable { "true" } else { "false" };
	let data_prefix = format!(
		"id=\"{}\" data-anchor=\"{}\" data-source-line=\"{}\" data-source-end-line=\"{}\" \
		 data-editable=\"{}\"",
		block.anchor, block.anchor, block.span.start_line, block.span.end_line, editable
	);
	match block.kind {
		BlockKind::Heading => render_text_group(
			&data_prefix,
			bounds,
			&block.text,
			match block.level.unwrap_or(1) {
				1 => 30.0,
				2 => 24.0,
				_ => 20.0,
			},
			700,
			"#1f2430",
			degraded,
		),
		BlockKind::Paragraph => {
			render_text_group(&data_prefix, bounds, &block.text, 18.0, 400, "#2e3440", degraded)
		},
		BlockKind::ListItem => {
			let bullet_x = bounds.x + 8.0;
			format!(
				"<g {data_prefix}><circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"4\" fill=\"#4c6ef5\" />{}</g>",
				bullet_x,
				bounds.y + 20.0,
				render_text_lines(
					bounds.x + 24.0,
					bounds.y + 24.0,
					bounds.width - 24.0,
					&block.text,
					18.0,
					400,
					"#2e3440"
				)
			)
		},
		BlockKind::Image => {
			let label = escape_xml(&block.text);
			let outline = if block.editable { "#7c3aed" } else { "#f59f00" };
			format!(
				"<g {data_prefix}><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" \
				 rx=\"18\" fill=\"#f3e8ff\" stroke=\"{outline}\" stroke-width=\"2\" /><text \
				 x=\"{:.1}\" y=\"{:.1}\" font-size=\"18\" font-weight=\"600\" \
				 fill=\"#5b21b6\">Image</text><text x=\"{:.1}\" y=\"{:.1}\" font-size=\"15\" \
				 fill=\"#7c3aed\">{label}</text></g>",
				bounds.x,
				bounds.y,
				bounds.width,
				bounds.height,
				bounds.x + 24.0,
				bounds.y + 42.0,
				bounds.x + 24.0,
				bounds.y + 74.0,
			)
		},
		BlockKind::Table => render_table(&data_prefix, bounds, block),
		BlockKind::Variable => {
			let background = if degraded { "#fff4e6" } else { "#eff6ff" };
			let stroke = if degraded { "#f59f00" } else { "#60a5fa" };
			format!(
				"<g {data_prefix}><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" \
				 rx=\"14\" fill=\"{background}\" stroke=\"{stroke}\" stroke-width=\"1.5\" />{}</g>",
				bounds.x,
				bounds.y,
				bounds.width,
				bounds.height,
				render_text_lines(
					bounds.x + 18.0,
					bounds.y + 30.0,
					bounds.width - 36.0,
					&block.text,
					16.0,
					500,
					"#1d4ed8"
				)
			)
		},
		BlockKind::Unsupported => {
			let reason = escape_xml(&format!(
				"Preview only — unsupported Typst construct at lines {}-{}",
				block.span.start_line, block.span.end_line
			));
			format!(
				"<g {data_prefix}><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" \
				 rx=\"14\" fill=\"#fff1f2\" stroke=\"#f43f5e\" stroke-width=\"2\" \
				 stroke-dasharray=\"8 6\" /><text x=\"{:.1}\" y=\"{:.1}\" font-size=\"17\" \
				 font-weight=\"700\" fill=\"#be123c\">Unsupported region</text><text x=\"{:.1}\" \
				 y=\"{:.1}\" font-size=\"14\" fill=\"#9f1239\">{reason}</text></g>",
				bounds.x,
				bounds.y,
				bounds.width,
				bounds.height,
				bounds.x + 18.0,
				bounds.y + 28.0,
				bounds.x + 18.0,
				bounds.y + 52.0,
			)
		},
	}
}

fn render_table(data_prefix: &str, bounds: &LayoutBounds, block: &ParsedBlock) -> String {
	let rows = block
		.meta
		.get("rows")
		.and_then(serde_json::Value::as_array)
		.cloned()
		.unwrap_or_default();
	let columns = rows
		.iter()
		.filter_map(serde_json::Value::as_array)
		.map(Vec::len)
		.max()
		.unwrap_or(1)
		.max(1);
	let cell_width = bounds.width / columns as f32;
	let row_height = 42.0;
	let mut fragments = vec![format!("<g {data_prefix}>")];
	for (row_index, row) in rows.iter().enumerate() {
		let cells = row.as_array().cloned().unwrap_or_default();
		for col_index in 0..columns {
			let x = bounds.x + cell_width * col_index as f32;
			let y = bounds.y + row_height * row_index as f32;
			let label = cells
				.get(col_index)
				.and_then(serde_json::Value::as_str)
				.unwrap_or("");
			fragments.push(format!(
				"<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{}\" \
				 stroke=\"#cbd5e1\" stroke-width=\"1\" />",
				x,
				y,
				cell_width,
				row_height,
				if row_index == 0 { "#e0f2fe" } else { "#ffffff" }
			));
			fragments.push(format!(
				"<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"15\" fill=\"#0f172a\">{}</text>",
				x + 12.0,
				y + 26.0,
				escape_xml(label)
			));
		}
	}
	fragments.push("</g>".to_string());
	fragments.join("")
}

fn render_text_group(
	data_prefix: &str,
	bounds: &LayoutBounds,
	text: &str,
	font_size: f32,
	weight: u32,
	fill: &str,
	degraded: bool,
) -> String {
	let outline = if degraded { "#f59f00" } else { "transparent" };
	format!(
		"<g {data_prefix}><rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"12\" \
		 fill=\"transparent\" stroke=\"{outline}\" stroke-width=\"1\" />{}</g>",
		bounds.x - 8.0,
		bounds.y - 8.0,
		bounds.width + 16.0,
		bounds.height + 4.0,
		render_text_lines(
			bounds.x,
			bounds.y + font_size,
			bounds.width,
			text,
			font_size,
			weight,
			fill
		)
	)
}

fn render_text_lines(
	x: f32,
	y: f32,
	width: f32,
	text: &str,
	font_size: f32,
	weight: u32,
	fill: &str,
) -> String {
	let max_chars = ((width / (font_size * 0.6)).floor() as usize).max(14);
	let mut lines = wrap_text(text, max_chars);
	if lines.is_empty() {
		lines.push(String::new());
	}
	let mut fragments = Vec::with_capacity(lines.len() + 2);
	fragments.push(format!(
		"<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"{:.1}\" font-weight=\"{weight}\" fill=\"{fill}\" \
		 font-family=\"Inter, Arial, sans-serif\">",
		x, y, font_size
	));
	for (index, line) in lines.iter().enumerate() {
		if index == 0 {
			fragments.push(format!("<tspan x=\"{:.1}\" dy=\"0\">{}</tspan>", x, escape_xml(line)));
		} else {
			fragments.push(format!(
				"<tspan x=\"{:.1}\" dy=\"{:.1}\">{}</tspan>",
				x,
				font_size * 1.35,
				escape_xml(line)
			));
		}
	}
	fragments.push("</text>".to_string());
	fragments.join("")
}

fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
	let mut lines = Vec::new();
	let mut current = String::new();
	for word in text.split_whitespace() {
		let projected = if current.is_empty() {
			word.len()
		} else {
			current.len() + 1 + word.len()
		};
		if projected > max_chars && !current.is_empty() {
			lines.push(current.clone());
			current.clear();
		}
		if !current.is_empty() {
			current.push(' ');
		}
		current.push_str(word);
	}
	if !current.is_empty() {
		lines.push(current);
	}
	lines
}

fn escape_xml(text: &str) -> String {
	text
		.replace('&', "&amp;")
		.replace('<', "&lt;")
		.replace('>', "&gt;")
		.replace('"', "&quot;")
		.replace('\'', "&apos;")
}
