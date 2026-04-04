import goTemplate from "./spell.coding.go.kdl" with { type: "text" };
import pythonTemplate from "./spell.coding.python.kdl" with { type: "text" };
import rustTemplate from "./spell.coding.rust.kdl" with { type: "text" };
import typescriptTemplate from "./spell.coding.typescript.kdl" with { type: "text" };
import growthTemplate from "./spell.growth.default.kdl" with { type: "text" };

const TEMPLATES: Record<string, string> = {
	"spell.coding.typescript": typescriptTemplate,
	"spell.coding.rust": rustTemplate,
	"spell.coding.python": pythonTemplate,
	"spell.coding.go": goTemplate,
	"spell.growth.default": growthTemplate,
};

/** All available built-in template namespaces. */
export const TEMPLATE_NAMESPACES = Object.keys(TEMPLATES);

/** Resolve a dot-namespaced template reference to its KDL content. */
export function resolveTemplate(namespace: string): string | undefined {
	return TEMPLATES[namespace];
}
