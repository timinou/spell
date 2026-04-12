Search code snippets and technical content.
This tool behaves more like grep than natural-language web search.

<instruction>
- Query with exact symbols, identifiers, error strings, CLI flags, filenames, import paths, and short code fragments.
- Start with the smallest distinctive token; widen only if the first query is too broad.
- Prefer exact syntax when punctuation matters.
- Keep `query` terse; remove filler words, prose, and framing.
- Use `code_context` only for a few disambiguating tokens such as language, library, framework, repo, runtime, or API name.
- If a multi-word literal matters exactly, quote the shortest stable phrase first, then refine.
- When looking for usage examples of a specific API, search the symbol first; add surrounding call syntax only when needed.
</instruction>

<parameters>
- query: Grep-style code search query; use exact tokens, short fragments, or short quoted phrases.
- code_context: Optional disambiguation tokens only, not a sentence.
</parameters>

<examples>
Good queries:
- `Promise.withResolvers`
- `DIRENV_LOG_FORMAT`
- `"direnv loading"`
</examples>

<avoid>
- Do not use this tool for broad conceptual research, comparisons, or authoritative sourcing; use `web_search`, `web_search_deep`, or `fetch` instead.
- Do not put full-sentence instructions into `query` or `code_context`.
- Do not pack many weak terms into one query; one strong token plus minimal context usually works better.
</avoid>

<critical>
- `query` should be grep-style code search, not a natural-language request.
- `code_context` is optional and should stay short.
- If you need explanations, best practices, or comprehensive answers, use broader web search tools instead.
</critical>