export interface ClockHandle {
	id: number;
}

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): ClockHandle;
	clearTimeout(handle: ClockHandle): void;
}

export class RealClock implements Clock {
	#nextId = 1;
	#timers = new Map<number, NodeJS.Timeout>();

	now(): number {
		return Date.now();
	}

	setTimeout(callback: () => void, delayMs: number): ClockHandle {
		const id = this.#nextId++;
		const timer = globalThis.setTimeout(() => {
			this.#timers.delete(id);
			callback();
		}, delayMs);
		this.#timers.set(id, timer);
		return { id };
	}

	clearTimeout(handle: ClockHandle): void {
		const timer = this.#timers.get(handle.id);
		if (!timer) return;
		globalThis.clearTimeout(timer);
		this.#timers.delete(handle.id);
	}
}

interface VirtualTimer {
	id: number;
	at: number;
	callback: () => void;
}

export class VirtualClock implements Clock {
	#now = 0;
	#nextId = 1;
	#timers: VirtualTimer[] = [];

	now(): number {
		return this.#now;
	}

	setTimeout(callback: () => void, delayMs: number): ClockHandle {
		const id = this.#nextId++;
		this.#timers.push({ id, at: this.#now + Math.max(0, delayMs), callback });
		this.#timers.sort((left, right) => left.at - right.at || left.id - right.id);
		return { id };
	}

	clearTimeout(handle: ClockHandle): void {
		this.#timers = this.#timers.filter(timer => timer.id !== handle.id);
	}

	advance(delayMs: number): void {
		const target = this.#now + Math.max(0, delayMs);
		while (this.#timers.length > 0) {
			const next = this.#timers[0];
			if (!next || next.at > target) break;
			this.#timers.shift();
			this.#now = next.at;
			next.callback();
		}
		this.#now = target;
	}
}
