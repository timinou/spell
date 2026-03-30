export interface AuditState {
	/** Whether an audit is pending after plan execution completes */
	pending: "auto" | "suggest" | false;
	/** Whether the audit prompt has been injected and we're waiting for the response */
	active: boolean;
	/** Reference to the plan/item being audited (org ID or file path) */
	sourceRef?: string;
	/** Current audit cycle depth (0-indexed) */
	auditDepth?: number;
	/** Maximum allowed audit cycles */
	maxDepth?: number;
}

const AUDIT_CLEAN_RE = /\[AUDIT[_\s]?CLEAN\]/i;

/** Check if audit response indicates no actionable findings. */
export function isAuditClean(text: string): boolean {
	return AUDIT_CLEAN_RE.test(text);
}
