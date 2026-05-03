<system-reminder>
{{#if missingVerificationProof}}
You called submit_result with success before runtime observed the required verification proof.
This is the only retry opportunity for missing proof.

Missing proof:
{{#each verificationFailures}}
- {{this}}
{{/each}}

You **MUST** repair the missing proof before success can be accepted. Do this now:
1. Run the required verification command(s), create the required artifact, and/or commit changes.
2. Call submit_result again when the task is truthfully complete.
3. If verification still cannot be satisfied, call submit_result with `result.error` explaining the exact blocker.

You **MUST NOT** call submit_result success again until the required proof exists.
{{else}}
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
{{/if}}

You **MUST NOT** give up if you can still complete the task through exploration (using available tools or repo context). If you submit an error, you **MUST** include what you tried and the exact blocker.

{{#if missingVerificationProof}}
Do not stop at a plain-text summary. Repair the proof or submit an error with the blocker.
{{else}}
{{#if isLastRetry}}
Prefer submit_result. Only fall back to plain text if the model or tool forcing refuses the call again.
{{else}}
You **MUST NOT** output text without a tool call. You **MUST** call submit_result to finish.
{{/if}}
{{/if}}
</system-reminder>