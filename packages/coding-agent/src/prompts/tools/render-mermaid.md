Convert Mermaid graph source into ASCII diagram output.

Parameters:
- `mermaid` (required): Mermaid graph text to render.
- `config` (optional): JSON render configuration (spacing and layout options).
Behavior:
- Returns ASCII diagram text.
- Saves full ASCII output to a session-scoped artifact URL (for example `artifact://14b64b/main/render_mermaid/0.txt`) when artifact storage is available.
- Returns an error when the Mermaid input is invalid or rendering fails.