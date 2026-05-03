Asks the user for clarification or input.

<conditions>
Use when ambiguity remains after exhausting repo context and the choices have materially different tradeoffs.
</conditions>

<instruction>
- Default to action when repo conventions resolve the ambiguity
- If multiple choices are acceptable, pick the most conservative standard option and proceed
- Use `recommended` for the default choice; use `questions` for related questions; set `multi: true` when multiple selections are allowed
- Provide 2-5 concise distinct options; do not include an "Other" option
</instruction>