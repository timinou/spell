pub mod ast;
pub mod dialect;
pub mod types;

pub use ast::*;
pub use dialect::*;
pub use types::*;

/// Placeholder for the kernel winnow parser.
pub mod parser {
	use crate::{ast::CodePath, dialect::NameLexer};

	/// Parse a CodePath expression string using the given NameLexer for
	/// dialect-specific name payloads.
	#[allow(dead_code)]
	pub fn parse_code_path<N: NameLexer>(
		_input: &str,
		_name_lexer: &N,
	) -> Result<CodePath, crate::types::Diagnostic> {
		Err(crate::types::Diagnostic {
			variant: crate::types::DiagnosticVariant::UnsupportedOperation,
			message: "parser not yet implemented".to_string(),
			span:    None,
		})
	}
}
