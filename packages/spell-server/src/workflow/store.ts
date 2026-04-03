import type {
	WorkflowApprovalItem,
	WorkflowAuditEntry,
	WorkflowDownstreamJob,
	WorkflowItem,
	WorkflowItemFilter,
	WorkflowJobFilter,
	WorkflowRequestRecord,
} from "./types";

export class WorkflowStore {
	#items = new Map<string, WorkflowItem>();
	#audit = new Map<string, WorkflowAuditEntry>();
	#jobs = new Map<string, WorkflowDownstreamJob>();
	#requests = new Map<string, WorkflowRequestRecord>();
	#itemCounter = 0;
	#auditCounter = 0;
	#jobCounter = 0;
	#attemptCounter = 0;

	nextItemId(kind: WorkflowItem["kind"]): string {
		this.#itemCounter += 1;
		return `${kind}-${this.#itemCounter}`;
	}

	nextAuditId(): string {
		this.#auditCounter += 1;
		return `audit-${this.#auditCounter}`;
	}

	nextJobId(): string {
		this.#jobCounter += 1;
		return `job-${this.#jobCounter}`;
	}

	nextAttemptId(): string {
		this.#attemptCounter += 1;
		return `attempt-${this.#attemptCounter}`;
	}

	saveItem(item: WorkflowItem): WorkflowItem {
		this.#items.set(item.id, structuredClone(item));
		return structuredClone(item);
	}

	getItem(itemId: string): WorkflowItem | undefined {
		const item = this.#items.get(itemId);
		return item ? structuredClone(item) : undefined;
	}

	requireItem(itemId: string): WorkflowItem {
		const item = this.getItem(itemId);
		if (!item) {
			throw new Error(`Unknown workflow item: ${itemId}`);
		}
		return item;
	}

	listItems(filter: WorkflowItemFilter = {}): WorkflowItem[] {
		return [...this.#items.values()]
			.filter(item => {
				if (filter.kind && item.kind !== filter.kind) return false;
				if (filter.state && item.state !== filter.state) return false;
				if (filter.workflowId && item.workflowId !== filter.workflowId) return false;
				return true;
			})
			.map(item => structuredClone(item))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	listApprovals(filter: Omit<WorkflowItemFilter, "kind"> = {}): WorkflowApprovalItem[] {
		return this.listItems({ ...filter, kind: "approval" }) as WorkflowApprovalItem[];
	}

	appendAudit(entry: WorkflowAuditEntry): WorkflowAuditEntry {
		this.#audit.set(entry.id, structuredClone(entry));
		return structuredClone(entry);
	}

	listAudit(itemId?: string): WorkflowAuditEntry[] {
		return [...this.#audit.values()]
			.filter(entry => (itemId ? entry.itemId === itemId : true))
			.map(entry => structuredClone(entry))
			.sort((left, right) => left.at.localeCompare(right.at));
	}

	saveJob(job: WorkflowDownstreamJob): WorkflowDownstreamJob {
		this.#jobs.set(job.id, structuredClone(job));
		return structuredClone(job);
	}

	getJob(jobId: string): WorkflowDownstreamJob | undefined {
		const job = this.#jobs.get(jobId);
		return job ? structuredClone(job) : undefined;
	}

	requireJob(jobId: string): WorkflowDownstreamJob {
		const job = this.getJob(jobId);
		if (!job) {
			throw new Error(`Unknown downstream job: ${jobId}`);
		}
		return job;
	}

	listJobs(filter: WorkflowJobFilter = {}): WorkflowDownstreamJob[] {
		return [...this.#jobs.values()]
			.filter(job => {
				if (filter.kind && job.kind !== filter.kind) return false;
				if (filter.status && job.status !== filter.status) return false;
				if (filter.itemId && job.itemId !== filter.itemId) return false;
				return true;
			})
			.map(job => structuredClone(job))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	recordRequest(record: WorkflowRequestRecord): void {
		this.#requests.set(`${record.itemId}:${record.requestId}`, structuredClone(record));
	}

	getRequest(itemId: string, requestId: string): WorkflowRequestRecord | undefined {
		const record = this.#requests.get(`${itemId}:${requestId}`);
		return record ? structuredClone(record) : undefined;
	}

	allItems(): WorkflowItem[] {
		return this.listItems();
	}

	allJobs(): WorkflowDownstreamJob[] {
		return this.listJobs();
	}

	allAudit(): WorkflowAuditEntry[] {
		return this.listAudit();
	}
}
