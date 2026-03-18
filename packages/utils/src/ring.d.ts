/**
 * A fixed-capacity circular buffer that supports efficient push/pop/shift/unshift operations.
 * When the buffer is full, adding new items overwrites the oldest items (FIFO behavior).
 *
 * @template T The type of elements stored in the buffer.
 */
export declare class RingBuffer<T> {
    #private;
    readonly capacity: number;
    /**
     * Creates a new ring buffer with the specified capacity.
     *
     * @param capacity - The maximum number of elements the buffer can hold. Must be positive.
     */
    constructor(capacity: number);
    /**
     * The number of elements currently in the buffer.
     */
    get length(): number;
    /**
     * Whether the buffer is at full capacity.
     */
    get isFull(): boolean;
    /**
     * Whether the buffer is empty (contains no elements).
     */
    get isEmpty(): boolean;
    /**
     * Adds an item to the end of the buffer.
     * If the buffer is full, the oldest item is overwritten and returned.
     *
     * @param item - The item to add.
     * @returns The overwritten item if the buffer was full, otherwise `undefined`.
     */
    push(item: T): T | undefined;
    /**
     * Removes and returns the first (oldest) item from the buffer.
     *
     * @returns The removed item, or `undefined` if the buffer is empty.
     */
    shift(): T | undefined;
    /**
     * Removes and returns the last (newest) item from the buffer.
     *
     * @returns The removed item, or `undefined` if the buffer is empty.
     */
    pop(): T | undefined;
    /**
     * Adds an item to the beginning of the buffer.
     * If the buffer is full, the newest item is overwritten and returned.
     *
     * @param item - The item to add.
     * @returns The overwritten item if the buffer was full, otherwise `undefined`.
     */
    unshift(item: T): T | undefined;
    /**
     * Returns the element at the specified index without removing it.
     * Supports negative indices (e.g., `-1` for the last element).
     *
     * @param index - The zero-based index, or negative index from the end.
     * @returns The element at the index, or `undefined` if the index is out of bounds.
     */
    at(index: number): T | undefined;
    /**
     * Returns the first (oldest) element without removing it.
     *
     * @returns The first element, or `undefined` if the buffer is empty.
     */
    peek(): T | undefined;
    /**
     * Returns the last (newest) element without removing it.
     *
     * @returns The last element, or `undefined` if the buffer is empty.
     */
    peekBack(): T | undefined;
    /**
     * Removes all elements from the buffer, resetting it to an empty state.
     */
    clear(): void;
    /**
     * Returns an iterator that yields elements in logical order (oldest to newest).
     * Allows the buffer to be used with `for...of` loops and spread syntax.
     *
     * @yields Elements in FIFO order.
     */
    [Symbol.iterator](): Iterator<T>;
    /**
     * Creates a new array containing all elements in logical order (oldest to newest).
     *
     * @returns A new array with all buffer elements.
     */
    toArray(): T[];
}
//# sourceMappingURL=ring.d.ts.map