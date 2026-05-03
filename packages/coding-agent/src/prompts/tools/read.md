Reads files from local filesystem or internal URLs.

<instruction>
- Reads up to {{DEFAULT_LIMIT}} lines by default; use `offset` and `limit` for larger files
- Supports images and PDFs
- Directories return a formatted listing with modification times
- Parallelize reads when exploring related files
</instruction>

<output>
Returns text for files, visual content for images, extracted text for PDFs, and filename suggestions for missing files.
</output>

<critical>
- Use `read` instead of bash for all file reading
- Use `read(path="dir/")` instead of `ls`
- Always include `path`
- Use `offset` and `limit` for ranges
</critical>