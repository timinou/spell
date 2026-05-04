# Text Dialect

Always present, parallel to every file's primary code dialect. The text dialect
bypasses tree-sitter entirely and operates on opaque bytes with structural axes.
It is the fallback for unknown extensions and the only dialect available for
binary or non-code files.

---

## A · NamePayload shape

Text nodes have **no NamePayload**. The head position in a Step is always a
node-kind axis (`§line`, `§chunk`, `§para`, `§span`). There is no name matching,
no identifier grammar, and no `NameLexer` implementation.

```rust
pub struct TextDialect;

// No NameLexer — the dialect skips semantic resolution entirely.
// Head resolution is kind-based only.
```

### Structural composition

```
§line[10..20]              line slice (1-indexed, inclusive end optional)
§chunk[n=50]               N-line block; default N = 20
§para[5]                   5th blank-line-separated paragraph
§span                      regex-match span produced by a [text~="re"] predicate
```

### Lazy indices

- **LineIndex:** built on first use. Maps 1-based line numbers to byte offsets
  by scanning for `\n`. Stored per `NodeRef` and invalidated on file change.
- **ParaIndex:** built on first use. Tracks blank-line boundaries.
- No eager full-file load unless a qualifier explicitly demands it (`#raw`,
  `#bytes`, `#text`).

---

## B · Registries

### Node kinds (`§name`)

```
§line          1-indexed line; carries leading-line-number metadata
§chunk         N-line block; defaults to N = 20, override with [n=…]
§para          blank-line-separated block
§span          regex-match span (start byte..end byte)
```

### Anchors (`¶name`)

None. The text dialect has no language landmarks.

### Qualifiers (`#name`)

```
#raw                   whole-file bytes as text (UTF-8; latin-1 fallback)
#text                  format-aware text extraction:
                         PDF  → pdf-extract
                         DOCX → docx-extract
                         JSON → pretty-print
                         HTML → readable-mode
#match                 just the matched span (string, not the containing §line)
#captures[N]            Nth regex capture group from the matching predicate
#lines[a..b]            line-slice content (1-indexed); same semantics as §line[a..b]
#bytes                 ArtifactHandle — no inline transfer; binary-safe
#image                 ImageHandle — uses existing image pipeline
#thumbnail[size]        generated preview at size N (e.g. #thumbnail[256])
```

### Predicates

```
[text~="re"]            regex match (PCRE-ish, ripgrep parity)
[match="literal"]       literal match (escaped, no regex)
[len>N]                 byte-length comparison
[multiline]             node spans more than one line (for §chunk / §para / §span)
[startsWith="…"]        prefix check
[endsWith="…"]          suffix check
[a..b]                  line slice (1-indexed, inclusive end optional)
[last]                  last line / last paragraph / last chunk
[-N..]                  last N items (e.g. [-3..] = last three lines)
```

### Combinators

```
<<                      adjacent preceding lines (leading context window)
>>                      adjacent following lines (trailing context window)
```

`<<` and `>>` are specialized for `§line` targets. They expand the result set
to include context lines without altering the match predicate. Chaining is
allowed:

```
§line[text~="error"]>>[0..3]<<[0..1]
```

---

## C · Worked examples

```ts
foo.ts :: §line[10..20]
// Line slice: lines 10 through 20 inclusive.

foo.ts :: §line[text~="useState"]
// Regex match on individual lines: every line containing "useState".

foo.ts :: §line[text~="useState"]>>[0..3]
// Match + 3 trailing context lines (4 lines total per match).

foo.ts :: §line[text~="useState"]<<[0..2]
// 2 leading context lines + match (3 lines total per match).

foo.ts :: #raw
// Full file content as UTF-8 text (latin-1 fallback diagnostic on failure).

foo.ts :: #lines[50..150]
// Equivalent to read(offset=50, limit=100). Content only, no node wrapper.

foo.pdf :: #text
// PDF extraction via existing pdf-extract pipeline.

img.png :: #image
// Image content via ImageHandle; optional qualifier chain:
// img.png :: #image#thumbnail[256]

foo.ts :: §line[text~="(\\w+)Config"]#captures[1]
// Capture-group extraction: returns the first capture from each matching line.

src/**/*.ts :: §line[text~="TODO"]
// Cross-file streaming grep: every line containing "TODO" across all .ts files.

README.md :: §para[text~="^# Installation"]
// Paragraph axis with multiline regex: the paragraph whose first line starts
// with "# Installation".
```

---

## D · Edge cases

```
D-1  Encoding: UTF-8 default. On decode failure, try latin-1 fallback and
     emit Diagnostic::EncodingFallback. Matches today's read tool behavior.

D-2  Large files (1 GiB+): streaming only. Never load the full file into
     memory unless a qualifier (#raw, #bytes, #text) explicitly demands it.
     LineIndex and ParaIndex are streaming scans; RSS MUST stay bounded.

D-3  Multiline regex: inline (?m) / (?s) flags. No separate dialect option.
     §para and §chunk are the natural axes for multiline matches; §line
     never spans lines regardless of regex flags.

D-4  Format-aware #text routing:
       .pdf  → pdf-extract
       .docx → docx-extract
       .json → pretty-print (2-space indent, sorted keys)
       .html → readable-mode (strip boilerplate, extract article text)
     Unknown extensions fall back to #raw.

D-5  Binary content NEVER inlined. #bytes and #image always return
     artifact:// handles. #raw on a binary file returns
     Diagnostic::BinaryContent and refuses inline transfer.

D-6  Capture groups threaded through NodeRef.metadata.captures as Vec<String>.
     #captures[N] is a qualifier, not a predicate: it post-processes an
     already-matched NodeRef. If N is out of bounds, emit
     Diagnostic::CaptureIndexOutOfBounds.

D-7  §span produced by [text~="re"] predicates with explicit byte ranges.
     Overlapping spans from a single line are returned as separate NodeRefs.
     Adjacent non-overlapping spans merge only when requested via a
     coalescing projection (not the default).

D-8  CRLF normalization: LineIndex is based on \n only. \r is treated as
     ordinary content. Rendering preserves the original line endings of the
     source file; normalization happens only for internal index computation.

D-9  Empty file: §line, §chunk, §para all return empty sets. #raw returns
     empty string. Predicates on empty sets short-circuit to empty.

D-10 Single-line file without trailing newline: treated as line 1. LineIndex
     length is 1. [last] and [-1..] both resolve correctly.
```

---

## E · Test suite

```rust
mod tests_text_dialect {
    // --- Line slicing
    #[test] fn t1_line_slice_10_to_20() {}

    // --- Regex matching on lines
    #[test] fn t2_line_regex_match_usestate() {}

    // --- Trailing context (>> combinators)
    #[test] fn t3_trailing_context_three_lines() {}

    // --- Leading context (<< combinators)
    #[test] fn t4_leading_context_two_lines() {}

    // --- Full-file raw qualifier
    #[test] fn t5_full_file_raw_utf8() {}

    // --- Line-range slice qualifier
    #[test] fn t6_line_range_qualifier_50_to_150() {}

    // --- PDF extraction via #text
    #[test] fn t7_pdf_text_extraction() {}

    // --- Image handle via #image
    #[test] fn t8_image_handle_png() {}

    // --- Capture-group extraction
    #[test] fn t9_capture_group_index_one() {}

    // --- Cross-file streaming grep
    #[test] fn t10_cross_file_streaming_todo() {}

    // --- Paragraph axis with multiline regex
    #[test] fn t11_paragraph_multiline_regex() {}

    // --- Encoding fallback
    #[test] fn t12_encoding_fallback_latin1() {}

    // --- Large-file streaming boundedness
    #[test] fn t13_large_file_rss_bounded() {}

    // --- Parity corpus: read tool
    #[test] fn t14_parity_read_20_golden_queries() {}

    // --- Parity corpus: grep tool
    #[test] fn t15_parity_grep_20_golden_queries() {}
}
```

Minimum corpus sizes: 50 line-slice pairs, 30 regex-match fixtures, 20 context-window cases, all 10 edge-case documents, all 15 test stubs.
