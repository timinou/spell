/**
 * Elicitation panel: renders a server's `elicitation/create` request — a
 * message plus a restricted-JSON-Schema form — and collects the user's
 * response (accept with content, decline, or cancel).
 *
 * Field kinds map to controls:
 *   string            → text Input
 *   string + enum     → cycling selector (←/→ or space)
 *   number / integer  → text Input (parsed on accept)
 *   boolean           → toggle (space / ←/→)
 *
 * Navigation: ↑/↓ (or Tab) move between fields; Enter accepts; Esc cancels;
 * Ctrl+D declines. The result mirrors the MCP elicitation spec.
 */
import { Container, Input, type KeyId, matchesKey, Spacer, Text, type TUI } from "@spell/pi-tui";
import type { ElicitationProperty, ElicitationSchema, MCPElicitationResult } from "../../mcp/types";
import { theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

interface FieldState {
	key: string;
	prop: ElicitationProperty;
	label: string;
	/** For string/number fields. */
	input?: Input;
	/** For enum fields: current index into prop.enum. */
	enumIndex?: number;
	/** For boolean fields. */
	boolValue?: boolean;
}

export interface ElicitationOptions {
	tui?: TUI;
	onTogglePause?: () => void;
	togglePauseKeys?: KeyId[];
}

export class ElicitationComponent extends Container {
	#fields: FieldState[];
	#required: Set<string>;
	#activeField = 0;
	#onSubmit: (result: MCPElicitationResult) => void;
	#statusText: Text;
	#fieldTexts: Text[] = [];
	#onTogglePause: (() => void) | undefined;
	#togglePauseKeys: KeyId[];

	constructor(
		message: string,
		schema: ElicitationSchema,
		onSubmit: (result: MCPElicitationResult) => void,
		opts?: ElicitationOptions,
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onTogglePause = opts?.onTogglePause;
		this.#togglePauseKeys = opts?.togglePauseKeys ?? [];
		this.#required = new Set(schema.required ?? []);

		const props = schema.properties ?? {};
		this.#fields = Object.entries(props).map(([key, prop]) => {
			const label = prop.title ?? key;
			const field: FieldState = { key, prop, label };
			if (prop.type === "boolean") {
				field.boolValue = typeof prop.default === "boolean" ? prop.default : false;
			} else if (prop.enum && prop.enum.length > 0) {
				const def = typeof prop.default === "string" ? prop.enum.indexOf(prop.default) : 0;
				field.enumIndex = def >= 0 ? def : 0;
			} else {
				const input = new Input();
				if (prop.default !== undefined) input.setValue(String(prop.default));
				field.input = input;
			}
			return field;
		});

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", message), 1, 0));
		this.addChild(new Spacer(1));

		// One row per field. Inputs are real child components; enum/bool render
		// as reflowed Text the component repaints on change.
		for (const field of this.#fields) {
			if (field.input) {
				this.addChild(new Text(theme.fg("dim", this.#fieldLabel(field)), 1, 0));
				this.addChild(field.input);
			} else {
				const t = new Text("", 1, 0);
				this.#fieldTexts.push(t);
				this.addChild(t);
			}
			this.addChild(new Spacer(1));
		}

		this.#statusText = new Text(
			theme.fg("dim", "↑/↓ field · space/←/→ toggle · enter accept · ctrl+d decline · esc cancel"),
			1,
			0,
		);
		this.addChild(this.#statusText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#repaintFields();
	}

	#fieldLabel(field: FieldState): string {
		const req = this.#required.has(field.key) ? " *" : "";
		return `${field.label}${req}`;
	}

	/** Repaint enum/boolean text rows + the active-field marker. */
	#repaintFields(): void {
		let textRow = 0;
		this.#fields.forEach((field, i) => {
			const active = i === this.#activeField;
			const marker = active ? theme.fg("accent", "▸ ") : "  ";
			if (field.input) {
				field.input.focused = active;
				return;
			}
			const t = this.#fieldTexts[textRow++];
			if (!t) return;
			let value = "";
			if (field.boolValue !== undefined) {
				value = field.boolValue ? "[✓] yes" : "[ ] no";
			} else if (field.prop.enum && field.enumIndex !== undefined) {
				const names = field.prop.enumNames ?? field.prop.enum;
				value = `‹ ${names[field.enumIndex] ?? field.prop.enum[field.enumIndex]} ›`;
			}
			const label = theme.fg(active ? "text" : "dim", `${this.#fieldLabel(field)}: `);
			t.setText(`${marker}${label}${value}`);
		});
		this.invalidate();
	}

	#moveField(delta: number): void {
		const n = this.#fields.length;
		if (n === 0) return;
		this.#activeField = (this.#activeField + delta + n) % n;
		this.#repaintFields();
	}

	#cycleActive(delta: number): void {
		const field = this.#fields[this.#activeField];
		if (!field) return;
		if (field.boolValue !== undefined) {
			field.boolValue = !field.boolValue;
		} else if (field.prop.enum && field.enumIndex !== undefined) {
			const len = field.prop.enum.length;
			field.enumIndex = (field.enumIndex + delta + len) % len;
		}
		this.#repaintFields();
	}

	#accept(): void {
		const content: Record<string, unknown> = {};
		for (const field of this.#fields) {
			if (field.boolValue !== undefined) {
				content[field.key] = field.boolValue;
			} else if (field.prop.enum && field.enumIndex !== undefined) {
				content[field.key] = field.prop.enum[field.enumIndex];
			} else if (field.input) {
				const raw = field.input.getValue();
				if (field.prop.type === "number" || field.prop.type === "integer") {
					const num = field.prop.type === "integer" ? parseInt(raw, 10) : Number(raw);
					if (raw.trim() !== "" && !Number.isNaN(num)) content[field.key] = num;
					else if (this.#required.has(field.key)) {
						this.#statusText.setText(theme.fg("error", `"${field.label}" must be a number`));
						this.invalidate();
						return;
					}
				} else if (raw.trim() !== "" || this.#required.has(field.key)) {
					content[field.key] = raw;
				}
			}
		}
		// Enforce required presence.
		for (const key of this.#required) {
			if (content[key] === undefined || content[key] === "") {
				const field = this.#fields.find(f => f.key === key);
				this.#statusText.setText(theme.fg("error", `"${field?.label ?? key}" is required`));
				this.invalidate();
				return;
			}
		}
		this.#onSubmit({ action: "accept", content });
	}

	handleInput(keyData: string): void {
		if (this.#togglePauseKeys.some(key => matchesKey(keyData, key))) {
			this.#onTogglePause?.();
			return;
		}
		const active = this.#fields[this.#activeField];
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#onSubmit({ action: "cancel" });
		} else if (matchesKey(keyData, "ctrl+d")) {
			this.#onSubmit({ action: "decline" });
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#accept();
		} else if (matchesKey(keyData, "up")) {
			this.#moveField(-1);
		} else if (matchesKey(keyData, "down") || matchesKey(keyData, "tab")) {
			this.#moveField(1);
		} else if (matchesKey(keyData, "left")) {
			this.#cycleActive(-1);
		} else if (matchesKey(keyData, "right")) {
			this.#cycleActive(1);
		} else if (keyData === " " && active && active.input === undefined) {
			// Space toggles enum/boolean fields (but is a literal char in inputs).
			this.#cycleActive(1);
		} else if (active?.input) {
			active.input.handleInput(keyData);
		}
	}

	dispose(): void {
		// No timers/resources to release; present for interface symmetry.
	}
}
