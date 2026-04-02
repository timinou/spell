export interface GoalScheduleEntry {
	goalName: string;
	cronExpression: string;
	timezone?: string;
	jitterMs: number;
	callback: () => void | Promise<void>;
}

export interface ScheduledGoalInfo {
	goalName: string;
	cronExpression: string;
	timezone?: string;
	jitterMs: number;
	nextFireTime: Date | null;
	running: boolean;
}
