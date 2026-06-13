import { describe, expect, it } from "bun:test";
import { buildCodexRequest } from "@spell/pi-coding-agent/tools/image-generation";

// Regression: tool_choice was "auto", which let the gpt-5.5 text model answer
// text-only and never emit an image, surfacing to callers as
// "No image data returned." (imageCount: 0). The hosted image_generation tool
// must be forced so an image is always produced.
describe("buildCodexRequest", () => {
	it("forces the hosted image_generation tool (never text-only)", () => {
		const body = buildCodexRequest({ prompt: "a red cube on a white table" }, []);

		expect(body.tool_choice).toEqual({ type: "image_generation" });
		expect(body.tool_choice).not.toBe("auto");
	});

	it("offers exactly the image_generation tool", () => {
		const body = buildCodexRequest({ prompt: "a logo" }, []);

		expect(body.tools).toHaveLength(1);
		expect(body.tools[0]?.type).toBe("image_generation");
	});

	it("maps an explicit image_size onto the tool spec", () => {
		const body = buildCodexRequest({ prompt: "wide banner", image_size: "1536x1024" }, []);

		expect(body.tools[0]?.size).toBe("1536x1024");
	});

	it("includes the prompt as input text", () => {
		const body = buildCodexRequest({ prompt: "a teapot" }, []);

		const text = body.input[0]?.content.find(part => part.type === "input_text")?.text;
		expect(text).toBe("a teapot");
	});

	it("appends provided reference images as input_image parts", () => {
		const body = buildCodexRequest({ prompt: "edit this" }, [
			{ data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
		]);

		const imageParts = body.input[0]?.content.filter(part => part.type === "input_image") ?? [];
		expect(imageParts).toHaveLength(1);
		expect(imageParts[0]?.image_url).toContain("data:image/png;base64,");
	});
});
