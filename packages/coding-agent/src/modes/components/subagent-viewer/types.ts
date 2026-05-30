import type { Container, TUI } from "@spell/pi-tui";

export interface SubagentViewerContext {
	chatContainer: Container;
	ui: TUI;
	toolOutputExpanded: boolean;
	cwd: string;
}
