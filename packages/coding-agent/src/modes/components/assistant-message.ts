import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { Container, Image, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { formatNumber, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { hasPendingMermaid, prerenderMermaid } from "../../modes/theme/mermaid-cache";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";

type SlotKind = "markdown-text" | "markdown-thinking-expanded" | "text-thinking-collapsed";

interface Slot {
	kind: SlotKind;
	component: Markdown | Text;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#prerenderInFlight = false;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;

	#leadingSpacer?: Spacer;
	#slotsByIndex: Slot[] = [];
	#trailingSpacerAfterContent: Map<number, Spacer> = new Map();
	#abortMarker?: { spacer: Spacer; text: Text };
	#errorMarker?: { spacer: Spacer; text: Text };
	#usageMarker?: { spacer: Spacer; text: Text };
	#toolImagesContainer?: Container;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#triggerMermaidPrerender(message: AssistantMessage): void {
		if (!TERMINAL.imageProtocol || this.#prerenderInFlight) return;

		// Check if any text content has pending mermaid blocks
		const hasPending = message.content.some(c => c.type === "text" && c.text.trim() && hasPendingMermaid(c.text));
		if (!hasPending) return;

		this.#prerenderInFlight = true;

		// Fire off background prerender
		void (async () => {
			try {
				for (const content of message.content) {
					if (content.type === "text" && content.text.trim() && hasPendingMermaid(content.text)) {
						prerenderMermaid(content.text);
					}
				}
			} catch (error) {
				logger.warn("Background mermaid prerender failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				this.#prerenderInFlight = false;
				// Invalidate to re-render with cached images
				this.invalidate();
			}
		})();
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;

		// Trigger background mermaid pre-rendering if needed
		this.#triggerMermaidPrerender(message);

		const hasVisibleContent = message.content.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		// 1. Leading spacer (mount once, kept stable)
		if (hasVisibleContent && !this.#leadingSpacer) {
			this.#leadingSpacer = new Spacer(1);
		} else if (!hasVisibleContent && this.#leadingSpacer) {
			this.#leadingSpacer = undefined;
		}

		// 2. Reconcile per-content-item slots (skip toolCall blocks — rendered elsewhere)
		let slotIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			const desired = this.#deriveSlotKind(block);
			if (!desired) continue; // toolCall, redactedThinking, empty text/thinking

			const hasVisibleContentAfter = message.content
				.slice(i + 1)
				.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

			const existing = this.#slotsByIndex[slotIndex];
			if (existing && existing.kind === desired.kind) {
				// Fast path: mutate in place
				this.#updateSlot(existing, desired);
			} else {
				// Slow path: rebuild this slot
				if (existing) {
					// Drop old trailing spacer tracking if present
					if (this.#trailingSpacerAfterContent.has(slotIndex)) {
						this.#trailingSpacerAfterContent.delete(slotIndex);
					}
				}
				const slot = this.#buildSlot(desired);
				this.#slotsByIndex[slotIndex] = slot;
			}

			// Handle per-slot trailing spacer (thinking blocks with content after)
			const needsTrailingSpacer =
				(desired.kind === "markdown-thinking-expanded" || desired.kind === "text-thinking-collapsed") &&
				hasVisibleContentAfter;
			if (needsTrailingSpacer && !this.#trailingSpacerAfterContent.has(slotIndex)) {
				this.#trailingSpacerAfterContent.set(slotIndex, new Spacer(1));
			} else if (!needsTrailingSpacer && this.#trailingSpacerAfterContent.has(slotIndex)) {
				this.#trailingSpacerAfterContent.delete(slotIndex);
			}

			slotIndex++;
		}

		// 3. Truncate trailing slots beyond active content
		while (this.#slotsByIndex.length > slotIndex) {
			const staleIndex = this.#slotsByIndex.length - 1;
			this.#slotsByIndex.pop();
			if (this.#trailingSpacerAfterContent.has(staleIndex)) {
				this.#trailingSpacerAfterContent.delete(staleIndex);
			}
		}

		// 4. Sync tool-images sub-container
		this.#syncToolImages();

		// 5. Sync trailing markers (abort/error/usage)
		this.#syncTrailingMarkers(message);

		// 6. Rebuild children array from stable state
		this.#rebuildChildrenArray();
	}

	#deriveSlotKind(block: AssistantMessage["content"][number]): { kind: SlotKind; text: string } | null {
		if (block.type === "text" && block.text.trim()) {
			return { kind: "markdown-text", text: block.text.trim() };
		}
		if (block.type === "thinking" && block.thinking.trim()) {
			if (this.hideThinkingBlock) {
				return { kind: "text-thinking-collapsed", text: "Thinking..." };
			}
			return { kind: "markdown-thinking-expanded", text: block.thinking.trim() };
		}
		return null; // toolCall, redactedThinking, or empty block
	}

	#buildSlot(desired: { kind: SlotKind; text: string }): Slot {
		switch (desired.kind) {
			case "markdown-text":
				return {
					kind: desired.kind,
					component: new Markdown(desired.text, 1, 0, getMarkdownTheme()),
				};
			case "markdown-thinking-expanded":
				return {
					kind: desired.kind,
					component: new Markdown(desired.text, 1, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
				};
			case "text-thinking-collapsed":
				return {
					kind: desired.kind,
					component: new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0),
				};
		}
	}

	#updateSlot(slot: Slot, desired: { kind: SlotKind; text: string }): void {
		if (slot.kind === "text-thinking-collapsed") {
			// Static label — never changes
			return;
		}
		slot.component.setText(desired.text);
	}

	#syncToolImages(): void {
		const images = Array.from(this.#toolImagesByCallId.values()).flat();
		if (images.length === 0) {
			this.#toolImagesContainer = undefined;
			return;
		}

		if (!this.#toolImagesContainer) {
			this.#toolImagesContainer = new Container();
		}
		this.#toolImagesContainer.clear();
		this.#toolImagesContainer.addChild(new Spacer(1));
		for (const image of images) {
			if (
				TERMINAL.imageProtocol &&
				(TERMINAL.imageProtocol !== ImageProtocol.Kitty || image.mimeType === "image/png")
			) {
				this.#toolImagesContainer.addChild(
					new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ maxWidthCells: 60 },
					),
				);
				continue;
			}
			this.#toolImagesContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#syncTrailingMarkers(message: AssistantMessage): void {
		const hasToolCalls = message.content.some(c => c.type === "toolCall");

		// Abort marker
		if (!hasToolCalls && message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			if (!this.#abortMarker) {
				this.#abortMarker = {
					spacer: new Spacer(1),
					text: new Text(theme.fg("error", abortMessage), 1, 0),
				};
			} else {
				this.#abortMarker.text.setText(theme.fg("error", abortMessage));
			}
		} else {
			this.#abortMarker = undefined;
		}

		// Error marker
		if (!hasToolCalls && message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			if (!this.#errorMarker) {
				this.#errorMarker = {
					spacer: new Spacer(1),
					text: new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0),
				};
			} else {
				this.#errorMarker.text.setText(theme.fg("error", `Error: ${errorMsg}`));
			}
		} else {
			this.#errorMarker = undefined;
		}

		// Usage marker
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				const totalPrompt = usage.input + usage.cacheRead;
				const cachePercent = totalPrompt > 0 ? ((usage.cacheRead / totalPrompt) * 100).toFixed(0) : "0";
				parts.push(`cache: ${formatNumber(usage.cacheRead)} (${cachePercent}%)`);
			}
			const usageText = parts.join("  ");
			if (!this.#usageMarker) {
				this.#usageMarker = {
					spacer: new Spacer(1),
					text: new Text(theme.fg("dim", usageText), 1, 0),
				};
			} else {
				this.#usageMarker.text.setText(theme.fg("dim", usageText));
			}
		} else {
			this.#usageMarker = undefined;
		}
	}

	#rebuildChildrenArray(): void {
		this.#contentContainer.clear();

		if (this.#leadingSpacer) {
			this.#contentContainer.addChild(this.#leadingSpacer);
		}

		for (let i = 0; i < this.#slotsByIndex.length; i++) {
			const slot = this.#slotsByIndex[i];
			this.#contentContainer.addChild(slot.component);
			const trailing = this.#trailingSpacerAfterContent.get(i);
			if (trailing) {
				this.#contentContainer.addChild(trailing);
			}
		}

		if (this.#toolImagesContainer) {
			this.#contentContainer.addChild(this.#toolImagesContainer);
		}

		if (this.#abortMarker) {
			this.#contentContainer.addChild(this.#abortMarker.spacer);
			this.#contentContainer.addChild(this.#abortMarker.text);
		}

		if (this.#errorMarker) {
			this.#contentContainer.addChild(this.#errorMarker.spacer);
			this.#contentContainer.addChild(this.#errorMarker.text);
		}

		if (this.#usageMarker) {
			this.#contentContainer.addChild(this.#usageMarker.spacer);
			this.#contentContainer.addChild(this.#usageMarker.text);
		}
	}
}
