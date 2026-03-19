Generate a revised fluid plan for this user request.

<user-request>
{{userPrompt}}
</user-request>

The previous plan was rejected for these reasons:
<critique>
{{critique}}
</critique>

Requirements for this retry:
- Address every critique item explicitly.
- Keep dependencies minimal and logical.
- Keep task descriptions concrete and outcome-oriented.
- Return only the revised JSON plan.
