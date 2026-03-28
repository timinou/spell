export class AsyncMutex {
	#tail = Promise.resolve();

	async acquire(): Promise<() => void> {
		const previous = this.#tail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#tail = previous.finally(() => promise);
		await previous;

		let released = false;
		return () => {
			if (released) return;
			released = true;
			resolve();
		};
	}

	async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

export class KeyedMutex<TKey> {
	#locks = new Map<TKey, AsyncMutex>();

	#getLock(key: TKey): AsyncMutex {
		let lock = this.#locks.get(key);
		if (!lock) {
			lock = new AsyncMutex();
			this.#locks.set(key, lock);
		}
		return lock;
	}

	withLock<T>(key: TKey, fn: () => T | Promise<T>): Promise<T> {
		return this.#getLock(key).withLock(fn);
	}
}
