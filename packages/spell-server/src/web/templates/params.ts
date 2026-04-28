import type { ManifestTemplateParam } from "../../manifest/types";

export class MissingParamError extends Error {
	constructor(
		readonly templateName: string,
		readonly paramName: string,
	) {
		super(`Template ${templateName}: required parameter '${paramName}' is missing`);
		this.name = "MissingParamError";
	}
}

export class UnknownParamError extends Error {
	constructor(
		readonly templateName: string,
		readonly paramName: string,
	) {
		super(`Template ${templateName}: unknown parameter '${paramName}'`);
		this.name = "UnknownParamError";
	}
}

export class ParamCoercionError extends Error {
	constructor(
		readonly templateName: string,
		readonly paramName: string,
		readonly expectedType: string,
		readonly raw: unknown,
	) {
		super(
			`Template ${templateName}: parameter '${paramName}' could not be coerced to ${expectedType} (received ${typeof raw})`,
		);
		this.name = "ParamCoercionError";
	}
}

export type CoercedParamValue = string | number | boolean;

function coerceOne(
	param: ManifestTemplateParam,
	raw: unknown,
	templateName: string,
): CoercedParamValue {
	switch (param.type) {
		case "string": {
			if (typeof raw === "string") return raw;
			if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
			throw new ParamCoercionError(templateName, param.name, "string", raw);
		}
		case "number": {
			if (typeof raw === "number") {
				if (!Number.isFinite(raw)) {
					throw new ParamCoercionError(templateName, param.name, "number", raw);
				}
				return raw;
			}
			if (typeof raw === "string") {
				const trimmed = raw.trim();
				const value = Number(trimmed);
				if (trimmed.length === 0 || !Number.isFinite(value)) {
					throw new ParamCoercionError(templateName, param.name, "number", raw);
				}
				return value;
			}
			throw new ParamCoercionError(templateName, param.name, "number", raw);
		}
		case "boolean": {
			if (typeof raw === "boolean") return raw;
			if (raw === "true" || raw === 1) return true;
			if (raw === "false" || raw === 0) return false;
			throw new ParamCoercionError(templateName, param.name, "boolean", raw);
		}
	}
}

/**
 * Validate and coerce raw web request parameters against a template's
 * declared parameter schema. Throws on missing required, unknown names, or
 * coercion failure so callers can surface a single typed 4xx response.
 */
export function coerceParams(
	templateName: string,
	declared: ManifestTemplateParam[],
	raw: Record<string, unknown>,
): Record<string, CoercedParamValue> {
	const known = new Map(declared.map(p => [p.name, p]));
	const result: Record<string, CoercedParamValue> = {};
	for (const [name] of Object.entries(raw)) {
		if (!known.has(name)) throw new UnknownParamError(templateName, name);
	}
	for (const param of declared) {
		const value = raw[param.name];
		if (value === undefined || value === null) {
			if (param.required) throw new MissingParamError(templateName, param.name);
			continue;
		}
		result[param.name] = coerceOne(param, value, templateName);
	}
	return result;
}
