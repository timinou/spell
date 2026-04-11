pub mod buffer;
pub mod diff;
pub mod edit;
pub mod error;
pub mod language;
pub mod navigate;
pub mod outline;

pub use buffer::{BufferInfo, BufferRegistry, BufferSnapshot, CodeBuffer, EditResult, TextEdit};
pub use diff::{DiffHunk, DiffKind, diff_lines};
pub use edit::{DragDirection, SpliceMode};
pub use error::{CodeEngineError, Result};
pub use language::{LanguageId, LanguageProfile, LanguageRegistry};