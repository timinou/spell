const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

export function formatRelative(epochMs: number, now = Date.now()): string {
	const diff = now - epochMs;
	if (diff < 30 * SECONDS) return "just now";
	if (diff < MINUTES) return `${Math.floor(diff / SECONDS)}s ago`;
	if (diff < HOURS) return `${Math.floor(diff / MINUTES)}m ago`;
	if (diff < DAYS) return `${Math.floor(diff / HOURS)}h ago`;
	return `${Math.floor(diff / DAYS)}d ago`;
}

export function formatClock(epochMs: number): string {
	const d = new Date(epochMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
