use std::{
    borrow::Cow,
    fs::File,
    io::{self, Cursor, Read},
    path::{Path, PathBuf},
};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{
    BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};
use ignore::WalkBuilder;
use rayon::prelude::*;
use smallvec::SmallVec;

pub const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_CONTEXT_LINES: u32 = 50;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("Regex error: {0}")]
    Regex(String),
    #[error("Search failed: {0}")]
    Search(#[from] io::Error),
    #[error("Path not found: {0}")]
    PathNotFound(String),
    #[error("Invalid glob pattern `{pattern}`: {message}")]
    InvalidGlob { pattern: String, message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    Content,
    Count,
}

#[derive(Clone, Debug)]
pub enum TypeFilter {
    Known { exts: &'static [&'static str], names: &'static [&'static str] },
    Custom(String),
}

impl TypeFilter {
    fn match_ext(&self, ext: &str) -> bool {
        match self {
            Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
            Self::Custom(custom_ext) => ext.eq_ignore_ascii_case(custom_ext),
        }
    }

    fn match_name(&self, name: &str) -> bool {
        match self {
            Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
            Self::Custom(ext) => ext.eq_ignore_ascii_case(name),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub pattern: String,
    pub path: PathBuf,
    pub glob: Option<String>,
    pub type_filter: Option<TypeFilter>,
    pub ignore_case: bool,
    pub multiline: bool,
    pub hidden: bool,
    pub gitignore: bool,
    pub max_count: Option<u64>,
    pub offset: u64,
    pub context_before: u32,
    pub context_after: u32,
    pub max_columns: Option<u32>,
    pub mode: OutputMode,
    pub max_file_bytes: u64,
}

impl SearchConfig {
    pub fn new(pattern: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            pattern: pattern.into(),
            path: path.into(),
            glob: None,
            type_filter: None,
            ignore_case: false,
            multiline: false,
            hidden: true,
            gitignore: true,
            max_count: None,
            offset: 0,
            context_before: 0,
            context_after: 0,
            max_columns: None,
            mode: OutputMode::Content,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContextLine {
    pub line_number: u64,
    pub line: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CollectedMatch {
    pub line_number: u64,
    pub line: String,
    pub context_before: Vec<ContextLine>,
    pub context_after: Vec<ContextLine>,
    pub truncated: bool,
    pub absolute_byte_offset: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContentSearchResult {
    pub matches: Vec<CollectedMatch>,
    pub match_count: u64,
    pub collected: u64,
    pub limit_reached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSearchResult {
    pub relative_path: String,
    pub matches: Vec<CollectedMatch>,
    pub match_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub total_matches: u64,
    pub files_with_matches: u64,
    pub files_searched: u64,
    pub limit_reached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: u64,
    pub line: String,
    pub context_before: Vec<ContextLine>,
    pub context_after: Vec<ContextLine>,
    pub truncated: bool,
    pub match_count: Option<u64>,
    pub absolute_byte_offset: u64,
}

struct MatchCollector {
    matches: Vec<CollectedMatch>,
    match_count: u64,
    collected_count: u64,
    max_count: Option<u64>,
    offset: u64,
    skipped: u64,
    limit_reached: bool,
    context_before: SmallVec<[ContextLine; 8]>,
    max_columns: Option<usize>,
    collect_matches: bool,
}

impl MatchCollector {
    fn new(
        max_count: Option<u64>,
        offset: u64,
        max_columns: Option<usize>,
        collect_matches: bool,
    ) -> Self {
        Self {
            matches: Vec::new(),
            match_count: 0,
            collected_count: 0,
            max_count,
            offset,
            skipped: 0,
            limit_reached: false,
            context_before: SmallVec::new(),
            max_columns,
            collect_matches,
        }
    }

    fn truncate_line(&self, line: &str) -> (String, bool) {
        match self.max_columns {
            Some(max) if line.len() > max => {
                let cut = max.saturating_sub(3);
                let boundary = floor_char_boundary(line, cut);
                (format!("{}...", &line[..boundary]), true)
            },
            _ => (line.to_string(), false),
        }
    }
}

fn floor_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn bytes_to_trimmed_string(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim_end().to_string(),
        Err(_) => String::from_utf8_lossy(bytes).trim_end().to_string(),
    }
}

impl Sink for MatchCollector {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> std::result::Result<bool, Self::Error> {
        self.match_count += 1;
        if self.limit_reached {
            return Ok(false);
        }
        if self.skipped < self.offset {
            self.skipped += 1;
            self.context_before.clear();
            return Ok(true);
        }
        if self.collect_matches {
            let raw_line = bytes_to_trimmed_string(mat.bytes());
            let (line, truncated) = self.truncate_line(&raw_line);
            self.matches.push(CollectedMatch {
                line_number: mat.line_number().unwrap_or(0),
                line,
                context_before: std::mem::take(&mut self.context_before).into_vec(),
                context_after: Vec::new(),
                truncated,
                absolute_byte_offset: mat.absolute_byte_offset(),
            });
        } else {
            self.context_before.clear();
        }
        self.collected_count += 1;
        if let Some(max) = self.max_count
            && self.collected_count >= max
        {
            self.limit_reached = true;
        }
        Ok(true)
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        ctx: &SinkContext<'_>,
    ) -> std::result::Result<bool, Self::Error> {
        if !self.collect_matches {
            return Ok(true);
        }
        let raw_line = bytes_to_trimmed_string(ctx.bytes());
        let (line, _) = self.truncate_line(&raw_line);
        let line_number = ctx.line_number().unwrap_or(0);
        match ctx.kind() {
            SinkContextKind::Before => self.context_before.push(ContextLine { line_number, line }),
            SinkContextKind::After => {
                if let Some(last_match) = self.matches.last_mut() {
                    last_match.context_after.push(ContextLine { line_number, line });
                }
            },
            SinkContextKind::Other => {},
        }
        Ok(true)
    }
}

pub fn parse_output_mode(mode: Option<&str>) -> OutputMode {
    match mode {
        Some("count" | "filesWithMatches") => OutputMode::Count,
        _ => OutputMode::Content,
    }
}

pub fn parse_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
    let normalized = type_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches('.').to_lowercase())?;

    let (exts, names): (&[&str], &[&str]) = match normalized.as_str() {
        "js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
        "ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
        "json" => (&["json", "jsonc", "json5"], &[]),
        "yaml" | "yml" => (&["yaml", "yml"], &[]),
        "toml" => (&["toml"], &[]),
        "md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
        "py" | "python" => (&["py", "pyi"], &[]),
        "rs" | "rust" => (&["rs"], &[]),
        "go" => (&["go"], &[]),
        "java" => (&["java"], &[]),
        "kt" | "kotlin" => (&["kt", "kts"], &[]),
        "c" => (&["c", "h"], &[]),
        "cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
        "cs" | "csharp" => (&["cs", "csx"], &[]),
        "php" => (&["php", "phtml"], &[]),
        "rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
        "sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
        "zsh" => (&["zsh"], &[]),
        "fish" => (&["fish"], &[]),
        "html" => (&["html", "htm"], &[]),
        "css" => (&["css"], &[]),
        "scss" => (&["scss"], &[]),
        "sass" => (&["sass"], &[]),
        "less" => (&["less"], &[]),
        "xml" => (&["xml"], &[]),
        "docker" | "dockerfile" => (&[], &["dockerfile"]),
        "make" | "makefile" => (&[], &["makefile"]),
        _ => return Some(TypeFilter::Custom(normalized)),
    };
    Some(TypeFilter::Known { exts, names })
}

pub fn resolve_context(
    context: Option<u32>,
    context_before: Option<u32>,
    context_after: Option<u32>,
) -> (u32, u32) {
    if context_before.is_some() || context_after.is_some() {
        (
            context_before.unwrap_or(0).min(MAX_CONTEXT_LINES),
            context_after.unwrap_or(0).min(MAX_CONTEXT_LINES),
        )
    } else {
        let value = context.unwrap_or(0).min(MAX_CONTEXT_LINES);
        (value, value)
    }
}

pub fn build_matcher(
    pattern: &str,
    ignore_case: bool,
    multiline: bool,
) -> Result<grep_regex::RegexMatcher, SearchError> {
    let sanitized = sanitize_braces(pattern);
    RegexMatcherBuilder::new()
        .case_insensitive(ignore_case)
        .multi_line(multiline)
        .build(&sanitized)
        .map_err(|err| SearchError::Regex(err.to_string()))
}

pub fn has_match(
    content: &[u8],
    pattern: &str,
    ignore_case: bool,
    multiline: bool,
) -> Result<bool, SearchError> {
    let matcher = build_matcher(pattern, ignore_case, multiline)?;
    Ok(matcher.is_match(content).unwrap_or(false))
}

pub fn search_content(
    content: &[u8],
    pattern: &str,
    ignore_case: bool,
    multiline: bool,
    params: SearchParams,
) -> Result<ContentSearchResult, SearchError> {
    let matcher = build_matcher(pattern, ignore_case, multiline)?;
    run_search(&matcher, content, params).map_err(SearchError::Search)
}

#[derive(Clone, Copy, Debug)]
pub struct SearchParams {
    pub context_before: u32,
    pub context_after: u32,
    pub max_columns: Option<u32>,
    pub mode: OutputMode,
    pub max_count: Option<u64>,
    pub offset: u64,
}

fn build_searcher(before_context: u32, after_context: u32) -> Searcher {
    SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .before_context(before_context as usize)
        .after_context(after_context as usize)
        .build()
}

fn run_search(
    matcher: &grep_regex::RegexMatcher,
    content: &[u8],
    params: SearchParams,
) -> io::Result<ContentSearchResult> {
    run_search_reader(matcher, Cursor::new(content), params)
}

pub fn run_search_reader<R: Read>(
    matcher: &grep_regex::RegexMatcher,
    reader: R,
    params: SearchParams,
) -> io::Result<ContentSearchResult> {
    let mut searcher = build_searcher(
        if params.mode == OutputMode::Content { params.context_before } else { 0 },
        if params.mode == OutputMode::Content { params.context_after } else { 0 },
    );
    let mut collector = MatchCollector::new(
        params.max_count,
        params.offset,
        params.max_columns.map(|v| v as usize),
        params.mode == OutputMode::Content,
    );
    searcher.search_reader(matcher, reader, &mut collector)?;
    Ok(ContentSearchResult {
        matches: collector.matches,
        match_count: collector.match_count,
        collected: collector.collected_count,
        limit_reached: collector.limit_reached,
    })
}

pub fn search_files(config: &SearchConfig) -> Result<SearchResult, SearchError> {
    let metadata = std::fs::metadata(&config.path)
        .map_err(|err| SearchError::PathNotFound(err.to_string()))?;
    let matcher = build_matcher(&config.pattern, config.ignore_case, config.multiline)?;

    let mut params = SearchParams {
        context_before: config.context_before,
        context_after: config.context_after,
        max_columns: config.max_columns,
        mode: config.mode,
        max_count: config.max_count,
        offset: config.offset,
    };
    if config.mode != OutputMode::Content {
        params.context_before = 0;
        params.context_after = 0;
    }

    if metadata.is_file() {
        return search_one_file(config, &matcher, params);
    }

    let entries = collect_files(config)?;
    if entries.is_empty() {
        return Ok(SearchResult::default());
    }

    if config.max_count.is_none() && config.offset == 0 {
        let results = run_parallel_search(&entries, &matcher, params, config.max_file_bytes);
        return Ok(aggregate_parallel(results, config.mode));
    }

    Ok(run_sequential_search(&entries, &matcher, params, config.max_file_bytes))
}

fn search_one_file(
    config: &SearchConfig,
    matcher: &grep_regex::RegexMatcher,
    params: SearchParams,
) -> Result<SearchResult, SearchError> {
    if let Some(filter) = config.type_filter.as_ref()
        && !matches_type_filter(&config.path, filter)
    {
        return Ok(SearchResult::default());
    }
    let Ok(file) = File::open(&config.path) else {
        return Ok(SearchResult::default());
    };
    let search = run_search_reader(matcher, file.take(config.max_file_bytes), params)?;
    if search.match_count == 0 {
        return Ok(SearchResult { files_searched: 1, ..SearchResult::default() });
    }
    let path = config.path.to_string_lossy().into_owned();
    let matches = match config.mode {
        OutputMode::Content => search
            .matches
            .into_iter()
            .map(|m| to_search_match(&path, m, None))
            .collect(),
        OutputMode::Count => vec![SearchMatch {
            path,
            line_number: 0,
            line: String::new(),
            context_before: Vec::new(),
            context_after: Vec::new(),
            truncated: false,
            match_count: Some(search.match_count),
            absolute_byte_offset: 0,
        }],
    };
    let limit_reached = search.limit_reached || config.max_count.is_some_and(|max| search.collected >= max);
    Ok(SearchResult {
        matches,
        total_matches: search.match_count,
        files_with_matches: 1,
        files_searched: 1,
        limit_reached,
    })
}

#[derive(Clone, Debug)]
pub struct SearchFile {
    pub path: PathBuf,
    pub relative_path: String,
}

type FileEntry = SearchFile;

pub fn search_file_list(
    pattern: &str,
    files: Vec<SearchFile>,
    ignore_case: bool,
    multiline: bool,
    params: SearchParams,
    max_file_bytes: u64,
) -> Result<SearchResult, SearchError> {
    if files.is_empty() {
        return Ok(SearchResult::default());
    }
    let matcher = build_matcher(pattern, ignore_case, multiline)?;
    if params.max_count.is_none() && params.offset == 0 {
        let results = run_parallel_search(&files, &matcher, params, max_file_bytes);
        return Ok(aggregate_parallel(results, params.mode));
    }
    Ok(run_sequential_search(&files, &matcher, params, max_file_bytes))
}

fn collect_files(config: &SearchConfig) -> Result<Vec<FileEntry>, SearchError> {
    let glob_set = compile_glob(config.glob.as_deref())?;
    let mut builder = WalkBuilder::new(&config.path);
    builder
        .hidden(!config.hidden)
        .git_ignore(config.gitignore)
        .git_exclude(config.gitignore)
        .git_global(config.gitignore)
        .ignore(config.gitignore)
        .parents(config.gitignore);
    if config.gitignore {
        builder.add_custom_ignore_filename(".gitignore");
    }

    let mut entries = Vec::new();
    for entry in builder.build() {
        let Ok(ent) = entry else { continue };
        let Some(ft) = ent.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let path = ent.path().to_path_buf();
        let Ok(rel) = path.strip_prefix(&config.path) else { continue };
        let relative_path = rel.to_string_lossy().to_string();
        if let Some(gs) = glob_set.as_ref()
            && !gs.is_match(rel)
        {
            continue;
        }
        if let Some(filter) = config.type_filter.as_ref()
            && !matches_type_filter(&path, filter)
        {
            continue;
        }
        entries.push(FileEntry { path, relative_path });
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(entries)
}

fn compile_glob(pattern: Option<&str>) -> Result<Option<GlobSet>, SearchError> {
    let Some(pattern) = pattern.filter(|p| !p.is_empty()) else { return Ok(None) };
    let mut builder = GlobSetBuilder::new();
    let glob = Glob::new(pattern).map_err(|e| SearchError::InvalidGlob {
        pattern: pattern.to_string(),
        message: e.to_string(),
    })?;
    builder.add(glob);
    builder.build().map(Some).map_err(|e| SearchError::InvalidGlob {
        pattern: pattern.to_string(),
        message: e.to_string(),
    })
}

fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
    let base_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if filter.match_name(base_name) {
        return true;
    }
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    !ext.is_empty() && filter.match_ext(ext)
}

fn run_parallel_search(
    entries: &[FileEntry],
    matcher: &grep_regex::RegexMatcher,
    params: SearchParams,
    max_file_bytes: u64,
) -> Vec<FileSearchResult> {
    let mut results: Vec<FileSearchResult> = entries
        .par_iter()
        .filter_map(|entry| {
            let file = File::open(&entry.path).ok()?;
            let search = run_search_reader(matcher, file.take(max_file_bytes), params).ok()?;
            Some(FileSearchResult {
                relative_path: entry.relative_path.clone(),
                matches: search.matches,
                match_count: search.match_count,
            })
        })
        .collect();
    results.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    results
}

fn aggregate_parallel(results: Vec<FileSearchResult>, mode: OutputMode) -> SearchResult {
    let files_searched = results.len() as u64;
    let mut matches = Vec::new();
    let mut total_matches = 0u64;
    let mut files_with_matches = 0u64;
    for result in results {
        if result.match_count == 0 {
            continue;
        }
        files_with_matches += 1;
        total_matches = total_matches.saturating_add(result.match_count);
        match mode {
            OutputMode::Content => {
                matches.extend(
                    result
                        .matches
                        .into_iter()
                        .map(|m| to_search_match(&result.relative_path, m, None)),
                );
            },
            OutputMode::Count => matches.push(SearchMatch {
                path: result.relative_path,
                line_number: 0,
                line: String::new(),
                context_before: Vec::new(),
                context_after: Vec::new(),
                truncated: false,
                match_count: Some(result.match_count),
                absolute_byte_offset: 0,
            }),
        }
    }
    SearchResult { matches, total_matches, files_with_matches, files_searched, limit_reached: false }
}

fn run_sequential_search(
    entries: &[FileEntry],
    matcher: &grep_regex::RegexMatcher,
    params: SearchParams,
    max_file_bytes: u64,
) -> SearchResult {
    let SearchParams { mode, max_count, offset, .. } = params;
    let mut matches = Vec::new();
    let mut total_matches = 0u64;
    let mut collected = 0u64;
    let mut files_with_matches = 0u64;
    let mut files_searched = 0u64;
    let mut limit_reached = false;

    for entry in entries {
        if limit_reached {
            break;
        }
        let file_offset = offset.saturating_sub(total_matches);
        let remaining = max_count.map(|max| max.saturating_sub(collected));
        if remaining == Some(0) {
            limit_reached = true;
            break;
        }
        let Ok(file) = File::open(&entry.path) else { continue };
        files_searched += 1;
        let file_params = SearchParams { max_count: remaining, offset: file_offset, ..params };
        let Ok(search) = run_search_reader(matcher, file.take(max_file_bytes), file_params) else {
            continue;
        };
        if search.match_count == 0 {
            continue;
        }
        files_with_matches += 1;
        total_matches = total_matches.saturating_add(search.match_count);
        collected = collected.saturating_add(search.collected);
        match mode {
            OutputMode::Content => matches.extend(
                search.matches.into_iter().map(|m| to_search_match(&entry.relative_path, m, None)),
            ),
            OutputMode::Count => matches.push(SearchMatch {
                path: entry.relative_path.clone(),
                line_number: 0,
                line: String::new(),
                context_before: Vec::new(),
                context_after: Vec::new(),
                truncated: false,
                match_count: Some(search.match_count),
                absolute_byte_offset: 0,
            }),
        }
        if search.limit_reached || max_count.is_some_and(|max| collected >= max) {
            limit_reached = true;
        }
    }

    SearchResult { matches, total_matches, files_with_matches, files_searched, limit_reached }
}

fn to_search_match(path: &str, matched: CollectedMatch, match_count: Option<u64>) -> SearchMatch {
    SearchMatch {
        path: path.to_string(),
        line_number: matched.line_number,
        line: matched.line,
        context_before: matched.context_before,
        context_after: matched.context_after,
        truncated: matched.truncated,
        match_count,
        absolute_byte_offset: matched.absolute_byte_offset,
    }
}

fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
    let len = bytes.len();
    let mut i = start + 1;
    if i >= len || !bytes[i].is_ascii_digit() {
        return None;
    }
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len {
        return None;
    }
    if bytes[i] == b'}' {
        return Some(i);
    }
    if bytes[i] != b',' {
        return None;
    }
    i += 1;
    if i >= len {
        return None;
    }
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i < len && bytes[i] == b'}' { Some(i) } else { None }
}

fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'}' {
            return Some(i);
        }
        i += 1;
    }
    None
}

pub fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
    let bytes = pattern.as_bytes();
    if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
        return Cow::Borrowed(pattern);
    }
    let len = bytes.len();
    let mut result = String::with_capacity(len + 8);
    let mut modified = false;
    let mut i = 0;
    while i < len {
        if bytes[i] == b'\\' && i + 1 < len {
            result.push('\\');
            i += 1;
            let ch = pattern[i..].chars().next().unwrap();
            result.push(ch);
            i += ch.len_utf8();
            if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
                if let Some(end) = find_braced_escape_end(bytes, i) {
                    result.push_str(&pattern[i..=end]);
                    i = end + 1;
                } else {
                    result.push_str(&pattern[i..]);
                    i = len;
                }
            }
            continue;
        }
        if bytes[i] == b'{' {
            if let Some(end) = find_valid_repetition(bytes, i) {
                result.push_str(&pattern[i..=end]);
                i = end + 1;
                continue;
            }
            result.push_str("\\{");
            i += 1;
            modified = true;
            continue;
        }
        if bytes[i] == b'}' {
            result.push_str("\\}");
            i += 1;
            modified = true;
            continue;
        }
        let ch = pattern[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    if modified { Cow::Owned(result) } else { Cow::Borrowed(pattern) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searches_files_with_gitignore_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("hit.txt"), "needle\n").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "needle\n").unwrap();
        let result = search_files(&SearchConfig::new("needle", dir.path())).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "hit.txt");
    }

    #[test]
    fn includes_hidden_by_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".hidden"), "needle\n").unwrap();
        let result = search_files(&SearchConfig::new("needle", dir.path())).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, ".hidden");
    }

    #[test]
    fn searches_alternation() {
        let result = search_content(
            b"glm\nGLM\nother\n",
            "glm|GLM",
            false,
            false,
            SearchParams {
                context_before: 0,
                context_after: 0,
                max_columns: None,
                mode: OutputMode::Content,
                max_count: None,
                offset: 0,
            },
        )
        .unwrap();
        assert_eq!(result.match_count, 2);
    }
}
