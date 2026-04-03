import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { settings } from "../../../config/settings";
import { AssistantMessageComponent } from "../assistant-message";
import { ReadToolGroupComponent } from "../read-tool-group";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../tool-execution";
import type { SubagentViewerContext } from "./types";

type ExpandableChild = {
	setExpanded(expanded: boolean): void;
};

function isExpandableChild(child: unknown): child is ExpandableChild {
	return (
		typeof child === "object" &&
		child !== null &&
		"setExpanded" in child &&
		typeof (child as ExpandableChild).setExpanded === "function"
	);
}

export class SubagentViewerEventHandler {
	#ctx: SubagentViewerContext;
	#pendingTools = new Map<string, ToolExecutionHandle>();
	#streamingComponent: AssistantMessageComponent | undefined;
	#lastReadGroup: ReadToolGroupComponent | undefined;

	constructor(ctx: SubagentViewerContext) {
		this.#ctx = ctx;
	}

	handleEvent(event: AgentEvent): void {
		let handled = false;

		switch (event.type) {
			case "message_start":
				if (event.message.role !== "assistant") {
					break;
				}
				this.#ctx.chatContainer.addChild(new Text("", 0, 0));
				this.#streamingComponent = new AssistantMessageComponent();
				this.#ctx.chatContainer.addChild(this.#streamingComponent);
				handled = true;
				break;

			case "message_update":
				if (this.#streamingComponent && event.message.role === "assistant") {
					this.#streamingComponent.updateContent(event.message);
					handled = true;
				}
				break;

			case "message_end":
				if (this.#streamingComponent && event.message.role === "assistant") {
					this.#streamingComponent.updateContent(event.message);
					this.#streamingComponent = undefined;
					handled = true;
				}
				break;

			case "tool_execution_start": {
				if (event.toolName === "read") {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.#pendingTools.set(event.toolCallId, group);
					handled = true;
					break;
				}

				this.#resetReadGroup();
				const component = new ToolExecutionComponent(
					event.toolName,
					event.args,
					{
						showImages: settings.get("terminal.showImages"),
						editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
						editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					},
					undefined,
					this.#ctx.ui,
					this.#ctx.cwd,
				);
				component.setExpanded(this.#ctx.toolOutputExpanded);
				this.#ctx.chatContainer.addChild(new Text("", 0, 0));
				this.#ctx.chatContainer.addChild(component);
				this.#pendingTools.set(event.toolCallId, component);
				handled = true;
				break;
			}

			case "tool_execution_update": {
				const component = this.#pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult(event.partialResult, true, event.toolCallId);
					handled = true;
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.#pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.#pendingTools.delete(event.toolCallId);
					handled = true;
				}
				break;
			}

			default:
				break;
		}

		if (handled) {
			this.#ctx.ui.requestRender();
		}
	}

	clear(): void {
		this.#pendingTools.clear();
		this.#streamingComponent = undefined;
		this.#lastReadGroup = undefined;
	}

	setExpanded(expanded: boolean): void {
		this.#ctx.toolOutputExpanded = expanded;
		for (const child of this.#ctx.chatContainer.children) {
			if (isExpandableChild(child)) {
				child.setExpanded(expanded);
			}
		}
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			this.#ctx.chatContainer.addChild(new Text("", 0, 0));
			const group = new ReadToolGroupComponent();
			group.setExpanded(this.#ctx.toolOutputExpanded);
			this.#ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#resetReadGroup(): void {
		this.#lastReadGroup = undefined;
	}
}
