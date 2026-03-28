<system-reminder>
You stopped without calling submit_result. This is reminder {{retryCount}} of {{maxRetries}}.

{{#if isLastRetry}}
This is the final reminder. Call submit_result now if you can.
- If task is complete: call submit_result with your result in `result.data`
- If task failed: call submit_result with `result.error` describing what happened
- If the model or tool forcing refuses the call again: summarize your results as plain text. Your output will be accepted but marked as incomplete.
{{else}}
You **MUST** call submit_result as your only action now. Choose one:
- If task is complete: call submit_result with your result in `result.data`
- If task failed: call submit_result with `result.error` describing what happened
{{/if}}

You **MUST NOT** give up if you can still complete the task through exploration (using available tools or repo context). If you submit an error, you **MUST** include what you tried and the exact blocker.

{{#if isLastRetry}}
Prefer submit_result. Only fall back to plain text if the model or tool forcing refuses the call again.
{{else}}
You **MUST NOT** output text without a tool call. You **MUST** call submit_result to finish.
{{/if}}
</system-reminder>