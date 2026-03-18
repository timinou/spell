// 16-bit hex lookup table (65536 entries) for fast conversion
const HEX4 = Array.from({ length: 65536 }, (_, i) => i.toString(16).padStart(4, "0"));
function randu32() {
    return crypto.getRandomValues(new Uint32Array(1))[0];
}
const EPOCH = 1420070400000;
const MAX_SEQ = 0x3fffff;
var Snowflake;
(function (Snowflake) {
    // Hex string validation pattern (16 lowercase hex chars).
    //
    Snowflake.PATTERN = /^[0-9a-f]{16}$/;
    // Epoch timestamp.
    //
    Snowflake.EPOCH_TIMESTAMP = EPOCH;
    // Maximum sequence number.
    //
    Snowflake.MAX_SEQUENCE = MAX_SEQ;
    // Parses a hex string or bigint to bigint.
    //
    function toBigInt(value) {
        const hi = Number.parseInt(value.substring(0, 8), 16);
        const lo = Number.parseInt(value.substring(8, 16), 16);
        return (BigInt(hi) << 32n) | BigInt(lo);
    }
    // Formats a sequence and timestamp into a snowflake hex string.
    //
    function formatParts(dt, seq) {
        // Split dt into hi/lo to avoid exceeding Number.MAX_SAFE_INTEGER.
        // dt is ~39 bits; dt<<22 would be ~61 bits, so we split at bit 10:
        //   lo32 = (dtLo << 22) | seq   (10+22 = 32 bits, no overlap)
        //   hi32 = dtHi                 (~29 bits)
        const dtLo = dt % 1024;
        const hi = (dt - dtLo) / 1024; // dt >>> 10
        const lo = ((dtLo << 22) | seq) >>> 0;
        const hi1 = (hi >>> 16) & 0xffff;
        const hi2 = hi & 0xffff;
        const lo1 = (lo >>> 16) & 0xffff;
        const lo2 = lo & 0xffff;
        return `${HEX4[hi1]}${HEX4[hi2]}${HEX4[lo1]}${HEX4[lo2]}`;
    }
    Snowflake.formatParts = formatParts;
    // Snowflake generator type.
    //
    class Source {
        #seq = 0;
        constructor(sequence = randu32() & MAX_SEQ) {
            this.#seq = sequence & MAX_SEQ;
        }
        // Sequence number.
        //
        get sequence() {
            return this.#seq & MAX_SEQ;
        }
        set sequence(v) {
            this.#seq = v & MAX_SEQ;
        }
        reset() {
            this.#seq = 0;
        }
        // Generates the next value as a hex string.
        //
        generate(timestamp) {
            const seq = (this.#seq + 1) & MAX_SEQ;
            const dt = timestamp - EPOCH;
            this.#seq = seq;
            return formatParts(dt, seq);
        }
    }
    Snowflake.Source = Source;
    // Gets the next snowflake given the timestamp.
    //
    const defaultSource = new Source();
    function next(timestamp = Date.now()) {
        return defaultSource.generate(timestamp);
    }
    Snowflake.next = next;
    // Validates a snowflake hex string.
    //
    function valid(value) {
        return value.length === 16 && Snowflake.PATTERN.test(value);
    }
    Snowflake.valid = valid;
    // Returns the upper/lower boundaries for the given timestamp.
    //
    function lowerbound(timelike) {
        switch (typeof timelike) {
            case "object": // Date
                return formatParts(timelike.getTime() - EPOCH, 0);
            case "number":
                return formatParts(timelike - EPOCH, 0);
            case "string": // Snowflake hex string
                return timelike;
        }
    }
    Snowflake.lowerbound = lowerbound;
    function upperbound(timelike) {
        switch (typeof timelike) {
            case "object": // Date
                return formatParts(timelike.getTime() - EPOCH, MAX_SEQ);
            case "number":
                return formatParts(timelike - EPOCH, MAX_SEQ);
            case "string": // Snowflake hex string
                return timelike;
        }
    }
    Snowflake.upperbound = upperbound;
    // Returns the individual bits given the snowflake.
    //
    function getSequence(value) {
        return Number.parseInt(value.substring(8, 16), 16) & MAX_SEQ;
    }
    Snowflake.getSequence = getSequence;
    function getTimestamp(value) {
        const n = toBigInt(value) >> 22n;
        return Number(n + BigInt(EPOCH));
    }
    Snowflake.getTimestamp = getTimestamp;
    function getDate(value) {
        return new Date(getTimestamp(value));
    }
    Snowflake.getDate = getDate;
})(Snowflake || (Snowflake = {}));
export { Snowflake };
//# sourceMappingURL=snowflake.js.map