export const browserCommandActions = [
	"browser:sync",
	"browser:goto",
	"browser:force_reload",
	"browser:evaluate",
	"browser:observe",
	"browser:click",
	"browser:type",
	"browser:fill",
	"browser:press",
	"browser:scroll",
	"browser:drag",
	"browser:wait_for_selector",
	"browser:get_text",
	"browser:get_html",
	"browser:get_attribute",
	"browser:extract_readable",
	"browser:screenshot",
] as const;

export type BrowserCommandAction = (typeof browserCommandActions)[number];

export const browserEventActions = [
	"browser:result",
	"browser:state",
	"browser:url_changed",
	"browser:navigation_blocked",
	"browser:navigation_failed",
	"browser:console",
] as const;

export type BrowserEventAction = (typeof browserEventActions)[number];
export type BrowserAction = BrowserCommandAction | BrowserEventAction;

export type BrowserLifecycleState = "idle" | "loading" | "interactive" | "error";
export type BrowserReadableFormat = "text" | "markdown";
export type BrowserEventClassification = "silent" | "loud";
export type BrowserCommandIdempotency = "idempotent" | "mutating";

export type BrowserErrorCode =
	| "invalid_action"
	| "invalid_payload"
	| "navigation_blocked"
	| "navigation_failed"
	| "script_error"
	| "selector_not_found"
	| "stale_element"
	| "timeout"
	| "unavailable"
	| "unsupported";

export interface BrowserRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserViewport {
	width: number;
	height: number;
	deviceScaleFactor: number;
}

export interface BrowserScrollState {
	x: number;
	y: number;
	width: number;
	height: number;
	scrollWidth: number;
	scrollHeight: number;
}

export interface BrowserTargetSummary {
	tag: string;
	role: string;
	name: string;
	text: string;
	selector: string;
	rect: BrowserRect;
}

export interface BrowserObservationEntry extends BrowserTargetSummary {
	id: number;
	value: string;
	description: string;
	states: string[];
}

export interface BrowserObservation {
	url: string;
	title: string;
	viewport: BrowserViewport;
	scroll: BrowserScrollState;
	elements: BrowserObservationEntry[];
}

export interface BrowserReadableResult {
	url: string;
	title: string;
	byline: string;
	excerpt: string;
	contentLength: number;
	text: string;
	markdown: string;
}

export interface BrowserError {
	code: BrowserErrorCode;
	message: string;
	detail: unknown;
}

export interface BrowserStateSnapshot {
	url: string;
	title: string;
	state: BrowserLifecycleState;
	statusText: string;
	lastError: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
}

export interface BrowserCommandBase {
	action: BrowserCommandAction;
	_rid?: string;
	timeout?: number;
	timeout_ms?: number;
}

export interface BrowserQueryRequest {
	selector: string;
	attribute?: string;
}

export interface BrowserSyncCommand extends BrowserCommandBase {
	action: "browser:sync";
}

export interface BrowserGotoCommand extends BrowserCommandBase {
	action: "browser:goto";
	url: string;
}

export interface BrowserForceReloadCommand extends BrowserCommandBase {
	action: "browser:force_reload";
}

export interface BrowserEvaluateCommand extends BrowserCommandBase {
	action: "browser:evaluate";
	script: string;
}

export interface BrowserObserveCommand extends BrowserCommandBase {
	action: "browser:observe";
	include_all?: boolean;
	viewport_only?: boolean;
	limit?: number;
}

export interface BrowserClickCommand extends BrowserCommandBase {
	action: "browser:click";
	selector?: string;
	element_id?: number;
	x?: number;
	y?: number;
}

export interface BrowserTypeCommand extends BrowserCommandBase {
	action: "browser:type";
	selector?: string;
	element_id?: number;
	text: string;
}

export interface BrowserFillCommand extends BrowserCommandBase {
	action: "browser:fill";
	selector?: string;
	element_id?: number;
	value: string;
}

export interface BrowserPressCommand extends BrowserCommandBase {
	action: "browser:press";
	key: string;
}

export interface BrowserScrollCommand extends BrowserCommandBase {
	action: "browser:scroll";
	selector?: string;
	element_id?: number;
	delta_x?: number;
	delta_y?: number;
}

export interface BrowserDragCommand extends BrowserCommandBase {
	action: "browser:drag";
	from_selector?: string;
	to_selector?: string;
	from_element_id?: number;
	to_element_id?: number;
	from_x?: number;
	from_y?: number;
	to_x?: number;
	to_y?: number;
}

export interface BrowserWaitForSelectorCommand extends BrowserCommandBase {
	action: "browser:wait_for_selector";
	selector: string;
	visible?: boolean;
}

export interface BrowserGetTextCommand extends BrowserCommandBase {
	action: "browser:get_text";
	selector?: string;
	args?: BrowserQueryRequest[];
}

export interface BrowserGetHtmlCommand extends BrowserCommandBase {
	action: "browser:get_html";
	selector?: string;
	args?: BrowserQueryRequest[];
}

export interface BrowserGetAttributeCommand extends BrowserCommandBase {
	action: "browser:get_attribute";
	selector?: string;
	attribute?: string;
	args?: BrowserQueryRequest[];
}

export interface BrowserExtractReadableCommand extends BrowserCommandBase {
	action: "browser:extract_readable";
	format?: BrowserReadableFormat;
}

export interface BrowserScreenshotCommand extends BrowserCommandBase {
	action: "browser:screenshot";
	path?: string;
	full_page?: boolean;
}

export type BrowserCommandPayload =
	| BrowserSyncCommand
	| BrowserGotoCommand
	| BrowserForceReloadCommand
	| BrowserEvaluateCommand
	| BrowserObserveCommand
	| BrowserClickCommand
	| BrowserTypeCommand
	| BrowserFillCommand
	| BrowserPressCommand
	| BrowserScrollCommand
	| BrowserDragCommand
	| BrowserWaitForSelectorCommand
	| BrowserGetTextCommand
	| BrowserGetHtmlCommand
	| BrowserGetAttributeCommand
	| BrowserExtractReadableCommand
	| BrowserScreenshotCommand;

export interface BrowserResultEvent {
	action: "browser:result";
	_rid: string;
	command: BrowserCommandAction;
	ok: boolean;
	result: unknown;
	error: BrowserError | null;
	url: string;
	title: string;
	state: BrowserLifecycleState;
}

export interface BrowserStateEvent extends BrowserStateSnapshot {
	action: "browser:state";
	silent: true;
}

export interface BrowserUrlChangedEvent {
	action: "browser:url_changed";
	url: string;
	title: string;
	silent: true;
}

export interface BrowserNavigationBlockedEvent {
	action: "browser:navigation_blocked";
	url: string;
	reason: string;
	detail: unknown;
	silent: false;
}

export interface BrowserNavigationFailedEvent {
	action: "browser:navigation_failed";
	url: string;
	error: string;
	errorCode?: number;
	silent: false;
}

export interface BrowserConsoleEvent {
	action: "browser:console";
	level: string;
	message: string;
	lineNumber: number;
	sourceId: string;
	silent: boolean;
}

export type BrowserEventPayload =
	| BrowserResultEvent
	| BrowserStateEvent
	| BrowserUrlChangedEvent
	| BrowserNavigationBlockedEvent
	| BrowserNavigationFailedEvent
	| BrowserConsoleEvent;

export type BrowserPayload = BrowserCommandPayload | BrowserEventPayload;

const browserCommandActionSet = new Set<BrowserCommandAction>(browserCommandActions);
const browserEventActionSet = new Set<BrowserEventAction>(browserEventActions);

export function isBrowserCommandAction(action: unknown): action is BrowserCommandAction {
	return typeof action === "string" && browserCommandActionSet.has(action as BrowserCommandAction);
}

export function isBrowserEventAction(action: unknown): action is BrowserEventAction {
	return typeof action === "string" && browserEventActionSet.has(action as BrowserEventAction);
}

export function isBrowserAction(action: unknown): action is BrowserAction {
	return isBrowserCommandAction(action) || isBrowserEventAction(action);
}

export function classifyBrowserPayload(payload: Record<string, unknown>): BrowserEventClassification | null {
	const action = payload.action;
	if (!isBrowserEventAction(action)) {
		return null;
	}
	if (payload.silent === true) {
		return "silent";
	}
	if (action === "browser:state" || action === "browser:url_changed") {
		return "silent";
	}
	if (action === "browser:console") {
		const level = String(payload.level ?? "");
		return /error/i.test(level) ? "loud" : "silent";
	}
	return "loud";
}

export function classifyBrowserCommandIdempotency(action: BrowserCommandAction): BrowserCommandIdempotency {
	switch (action) {
		case "browser:sync":
		case "browser:observe":
		case "browser:wait_for_selector":
		case "browser:get_text":
		case "browser:get_html":
		case "browser:get_attribute":
		case "browser:extract_readable":
		case "browser:screenshot":
			return "idempotent";
		default:
			return "mutating";
	}
}
