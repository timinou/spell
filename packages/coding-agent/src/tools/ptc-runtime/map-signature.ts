/**
 * Spell-side map-of signature dialect (FEAT-789 / friction F2).
 *
 * ptc_runner's signature grammar supports struct maps (`{name :string}`) and a
 * bare `:map`, but NOT a homogeneous map-of type (`{:string :int}` — "string
 * keys → int values"). That shape is the natural output of the runtime's
 * flagship idioms (`group-by`, `frequencies`, `update-vals count`), so a program
 * that produces one cannot validate its result under ptc_runner alone.
 *
 * Rather than fork the vendored dep, Spell extends the dialect HERE: a map-of
 * signature is detected, WITHHELD from ptc_runner (which would reject the
 * grammar), and the returned value is validated in-process after `execute`
 * resolves. Standard (struct/list/scalar) signatures are untouched and continue
 * to flow to ptc_runner for native validation.
 *
 * ## Grammar (the extension only)
 *
 *   mapOf   ::= '{' type type '}'          // exactly two type tokens: key, value
 *   type    ::= ':string' | ':int' | ':float' | ':bool' | ':keyword' | ':any'
 *             | mapOf | listOf
 *   listOf  ::= '[' type ']'
 *
 * A `{ ... }` with exactly two whitespace-separated TYPE tokens (no field
 * names) is a map-of; a `{ ... }` whose entries are `name :type` pairs is a
 * struct and is left for ptc_runner.
 */

/** A parsed map-of type tree. Scalars are leaf strings; containers recurse. */
export type MapSigType =
	| { kind: "scalar"; name: ScalarName }
	| { kind: "mapOf"; key: MapSigType; value: MapSigType }
	| { kind: "listOf"; element: MapSigType };

export type ScalarName = "string" | "int" | "float" | "bool" | "keyword" | "any";

const SCALARS: ReadonlySet<string> = new Set(["string", "int", "float", "bool", "keyword", "any"]);

/**
 * True if a signature string uses the map-of dialect anywhere. Cheap structural
 * probe: a `{` immediately followed (modulo whitespace) by a `:type` token means
 * the brace opens a map-of (a struct opens with a bare field name). Used to
 * decide whether to withhold the signature from ptc_runner.
 */
export function isMapOfSignature(signature: string): boolean {
	return /\{\s*(?::|\[|\{)/.test(signature);
}

/**
 * Parse a map-of signature into a type tree, or return an error message.
 * Whole-signature only (the result contract is one value); no param lists.
 */
export function parseMapSignature(signature: string): { ok: true; type: MapSigType } | { ok: false; error: string } {
	const tokens = tokenize(signature.trim());
	if (tokens.length === 0) return { ok: false, error: "empty signature" };
	const parser = new Parser(tokens);
	let type: MapSigType;
	try {
		type = parser.parseType();
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	if (!parser.atEnd()) return { ok: false, error: `unexpected trailing token '${parser.peek()}'` };
	return { ok: true, type };
}

/**
 * Validate a runtime value against a parsed map-of type. Returns null on
 * success or a human-readable path-qualified mismatch message.
 */
export function validateMapValue(value: unknown, type: MapSigType, path = "$"): string | null {
	switch (type.kind) {
		case "scalar":
			return validateScalar(value, type.name, path);
		case "listOf": {
			if (!Array.isArray(value)) return `${path}: expected list, got ${typeName(value)}`;
			for (let i = 0; i < value.length; i++) {
				const err = validateMapValue(value[i], type.element, `${path}[${i}]`);
				if (err) return err;
			}
			return null;
		}
		case "mapOf": {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				return `${path}: expected map, got ${typeName(value)}`;
			}
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				// JSON object keys are always strings; only :string/:keyword/:any key
				// types are satisfiable. Reject an :int/:float/:bool key type up front.
				const keyErr = validateScalar(k, scalarOf(type.key) ?? "any", `${path}.<key:${k}>`);
				if (type.key.kind === "scalar" && !keySatisfiable(type.key.name)) {
					return `${path}: map key type ':${type.key.name}' is not representable (JSON keys are strings)`;
				}
				if (keyErr && type.key.kind === "scalar" && type.key.name !== "any") return keyErr;
				const valErr = validateMapValue(v, type.value, `${path}.${k}`);
				if (valErr) return valErr;
			}
			return null;
		}
	}
}

function keySatisfiable(name: ScalarName): boolean {
	return name === "string" || name === "keyword" || name === "any";
}

function scalarOf(t: MapSigType): ScalarName | null {
	return t.kind === "scalar" ? t.name : null;
}

function validateScalar(value: unknown, name: ScalarName, path: string): string | null {
	switch (name) {
		case "any":
			return null;
		case "string":
		case "keyword":
			return typeof value === "string" ? null : `${path}: expected ${name}, got ${typeName(value)}`;
		case "int":
			return typeof value === "number" && Number.isInteger(value)
				? null
				: `${path}: expected int, got ${typeName(value)}`;
		case "float":
			return typeof value === "number" ? null : `${path}: expected float, got ${typeName(value)}`;
		case "bool":
			return typeof value === "boolean" ? null : `${path}: expected bool, got ${typeName(value)}`;
	}
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "list";
	return typeof value;
}

// ── tokenizer + recursive-descent parser ───────────────────────────────────

function tokenize(src: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "{" || c === "}" || c === "[" || c === "]") {
			out.push(c);
			i++;
			continue;
		}
		// A `:type` token runs to the next delimiter/whitespace.
		let j = i;
		while (j < src.length && !" \t\n\r{}[]".includes(src[j])) j++;
		out.push(src.slice(i, j));
		i = j;
	}
	return out;
}

class Parser {
	#tokens: string[];
	#pos = 0;

	constructor(tokens: string[]) {
		this.#tokens = tokens;
	}

	atEnd(): boolean {
		return this.#pos >= this.#tokens.length;
	}

	peek(): string | undefined {
		return this.#tokens[this.#pos];
	}

	#next(): string {
		const t = this.#tokens[this.#pos++];
		if (t === undefined) throw new Error("unexpected end of signature");
		return t;
	}

	parseType(): MapSigType {
		const t = this.peek();
		if (t === "{") return this.#parseMapOf();
		if (t === "[") return this.#parseListOf();
		return this.#parseScalar();
	}

	#parseScalar(): MapSigType {
		const t = this.#next();
		const name = t.startsWith(":") ? t.slice(1) : t;
		if (!SCALARS.has(name)) throw new Error(`unknown type token '${t}'`);
		return { kind: "scalar", name: name as ScalarName };
	}

	#parseMapOf(): MapSigType {
		this.#expect("{");
		const key = this.parseType();
		const value = this.parseType();
		this.#expect("}");
		return { kind: "mapOf", key, value };
	}

	#parseListOf(): MapSigType {
		this.#expect("[");
		const element = this.parseType();
		this.#expect("]");
		return { kind: "listOf", element };
	}

	#expect(tok: string): void {
		const t = this.#next();
		if (t !== tok) throw new Error(`expected '${tok}', got '${t}'`);
	}
}
