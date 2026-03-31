# Research Library

The browse interface automatically captures search results (web_search, code_search) and fetched URLs as findings in the research library. These auto-generated findings appear in the user's "All" findings view.

When you fetch a URL and discover noteworthy content, promote it to a curated finding so it appears in the user's default "Curated" findings view:

```
sendCustomMessage({
  customType: "finding",
  details: {
    url: "<the fetched URL>",
    title: "<descriptive title>",
    excerpt: "<1-2 sentence summary of why this is relevant>",
    tags: ["relevant", "topic", "tags"],
    sourceType: "agent"
  }
})
```

Guidelines:
- Only promote findings that directly answer the user's research question or contain high-value primary sources
- Do not promote every fetched URL — background navigation and low-relevance pages should remain uncurated
- Write excerpts that explain relevance, not just describe content
- Use 2-4 specific, lowercase tags per finding