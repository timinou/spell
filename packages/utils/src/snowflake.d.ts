type Snowflake = string & {
    readonly __brand: unique symbol;
};
declare namespace Snowflake {
    const PATTERN: RegExp;
    const EPOCH_TIMESTAMP = 1420070400000;
    const MAX_SEQUENCE = 4194303;
    function formatParts(dt: number, seq: number): Snowflake;
    class Source {
        #private;
        constructor(sequence?: number);
        get sequence(): number;
        set sequence(v: number);
        reset(): void;
        generate(timestamp: number): Snowflake;
    }
    function next(timestamp?: number): Snowflake;
    function valid(value: string): value is Snowflake;
    function lowerbound(timelike: Date | number | Snowflake): Snowflake;
    function upperbound(timelike: Date | number | Snowflake): Snowflake;
    function getSequence(value: Snowflake): number;
    function getTimestamp(value: Snowflake): number;
    function getDate(value: Snowflake): Date;
}
export { Snowflake };
//# sourceMappingURL=snowflake.d.ts.map