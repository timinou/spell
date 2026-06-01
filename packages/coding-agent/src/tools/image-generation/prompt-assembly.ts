/**
 * Slot-driven assembly of the prompt SENT TO the image model.
 *
 * This is the only place a literal "image prompt" exists — it is built from the
 * field values the LLM supplied, never stored in KDL. Reproduces the original
 * `assemblePrompt` behavior, generalized over schema slots:
 *
 *   core     → joined with ", " into the lead sentence
 *              ("subject, action, scene")
 *   sentence → its own sentence; `prefix` (if any) prepended as "Prefix: value"
 *              (". composition. lighting. style.")
 *   section  → a "\n\n<label>: <value>" block, in declaration order
 *              ("\n\nText: …")
 *
 * Edit-mode `changes[]` (a common field, not vocabulary) append a trailing
 * "\n\nChanges:" list, exactly as before.
 */

import type { ImageSchemaField } from "./schema-loader";

/** Strip trailing sentence punctuation so parts join cleanly with ". ". */
function trimTrailingPunctuation(text: string): string {
	return text.replace(/[.!,;:]+$/, "");
}

export interface AssembleImagePromptInput {
	/** Schema vocabulary fields, in declaration order. */
	fields: ImageSchemaField[];
	/** Field name → supplied string value (absent/empty values are skipped). */
	values: Record<string, string | undefined>;
	/** Edit-mode change directives (common field). */
	changes?: string[];
}

export function assembleImagePrompt(input: AssembleImagePromptInput): string {
	const { fields, values, changes } = input;

	const coreValues: string[] = [];
	const sentences: string[] = [];
	const sections: string[] = [];

	for (const field of fields) {
		const value = values[field.name]?.trim();
		if (!value) continue;
		switch (field.slot) {
			case "core":
				coreValues.push(value);
				break;
			case "sentence":
				sentences.push(field.prefix ? `${field.prefix} ${value}` : value);
				break;
			case "section": {
				const label = field.sectionLabel ?? field.name;
				sections.push(`\n\n${label}: ${value}`);
				break;
			}
		}
	}

	// Lead sentence (core fields) + technical sentences, joined as sentences.
	const sentenceParts: string[] = [];
	if (coreValues.length > 0) sentenceParts.push(coreValues.join(", "));
	sentenceParts.push(...sentences);

	let prompt = sentenceParts.length > 0 ? `${sentenceParts.map(trimTrailingPunctuation).join(". ")}.` : "";

	// Section blocks, in declaration order.
	prompt += sections.join("");

	// Edit-mode change directives.
	if (changes?.length) {
		prompt += `\n\nChanges:\n${changes.map(change => `- ${change}`).join("\n")}`;
	}

	return prompt;
}
