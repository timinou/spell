/**
 * Centralized file logger for spell.
 *
 * Logs to ~/.spell/logs/ with size-based rotation, supporting concurrent spell instances.
 * Each log entry includes process.pid for traceability.
 */
import * as fs from "node:fs";
import { RingBuffer } from "@oh-my-pi/pi-utils/ring";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { getLogsDir } from "./dirs";
/** Ensure logs directory exists */
function ensureLogsDir() {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    return logsDir;
}
/** Custom format that includes pid and flattens metadata */
const logFormat = winston.format.combine(winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }), winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const entry = {
        timestamp,
        level,
        pid: process.pid,
        message,
    };
    // Flatten metadata into entry
    for (const [key, value] of Object.entries(meta)) {
        if (key !== "level" && key !== "timestamp" && key !== "message") {
            entry[key] = value;
        }
    }
    return JSON.stringify(entry);
}));
/** Size-based rotating file transport */
const fileTransport = new DailyRotateFile({
    dirname: ensureLogsDir(),
    filename: "spell.%DATE%.log",
    datePattern: "YYYY-MM-DD",
    maxSize: "10m",
    maxFiles: 5,
    zippedArchive: true,
});
const STDERR_DEBUG_LEVELS = ["debug", "warn", "error"];
let stderrTransport = null;
/** The winston logger instance */
const winstonLogger = winston.createLogger({
    level: "debug",
    format: logFormat,
    transports: [fileTransport],
    // Don't exit on error - logging failures shouldn't crash the app
    exitOnError: false,
});
/**
 * Enable or disable mirroring logger output to stderr.
 * File rotation remains active regardless of this setting.
 */
export function setStderrDebugEnabled(enabled) {
    try {
        if (enabled) {
            if (stderrTransport !== null) {
                return;
            }
            stderrTransport = new winston.transports.Console({
                stderrLevels: STDERR_DEBUG_LEVELS,
            });
            winstonLogger.add(stderrTransport);
            return;
        }
        if (stderrTransport === null) {
            return;
        }
        winstonLogger.remove(stderrTransport);
        stderrTransport.close?.();
        stderrTransport = null;
    }
    catch {
        // Silently ignore logging failures
    }
}
/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message, context) {
    try {
        winstonLogger.error(message, context);
    }
    catch {
        // Silently ignore logging failures
    }
}
/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message, context) {
    try {
        winstonLogger.warn(message, context);
    }
    catch {
        // Silently ignore logging failures
    }
}
/**
 * Log an info message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function info(message, context) {
    try {
        winstonLogger.info(message, context);
    }
    catch {
        // Silently ignore logging failures
    }
}
/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message, context) {
    try {
        winstonLogger.debug(message, context);
    }
    catch {
        // Silently ignore logging failures
    }
}
const LOGGED_TIMING_THRESHOLD_MS = 5;
const longOpBuffer = new RingBuffer(1000);
let longOpRecord = false;
function logTiming(op, duration) {
    duration = Math.round(duration * 100) / 100;
    if (duration > LOGGED_TIMING_THRESHOLD_MS) {
        warn(`${op} done`, { duration, op });
        if (longOpRecord) {
            longOpBuffer.push([op, duration]);
        }
    }
    else {
        debug(`${op} done`, { duration, op });
    }
}
/**
 * Print all collected long operation timings to stderr.
 * To be called at the end of a startup or timing window.
 */
export function printTimings() {
    // Use stderr for timings output, do not use logger (see AGENTS.md).
    console.error("\n--- Startup Timings ---");
    let totalDuration = 0;
    for (const [op, duration] of longOpBuffer) {
        console.error(`  ${op}: ${duration}ms`);
        totalDuration += duration;
    }
    console.error(`  TOTAL: ${totalDuration}ms`);
    console.error("------------------------\n");
}
/**
 * Begin recording long operation timings.
 * Typically called at the beginning of startup.
 */
export function startTiming() {
    longOpBuffer.clear();
    longOpRecord = true;
}
/**
 * End timing window and print all timings.
 * Disables further buffering until next startTiming().
 */
export function endTiming() {
    longOpBuffer.clear();
    longOpRecord = false;
}
/**
 * Time a synchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export function time(op, fn, ...args) {
    const start = performance.now();
    try {
        return fn(...args);
    }
    finally {
        logTiming(op, performance.now() - start);
    }
}
/**
 * Time an asynchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export async function timeAsync(op, fn, ...args) {
    const start = performance.now();
    try {
        return await fn(...args);
    }
    finally {
        logTiming(op, performance.now() - start);
    }
}
let closed = false;
/**
 * Close the logger, flushing all pending writes.
 * After this call the logger is unusable — intended for process shutdown.
 * Idempotent: subsequent calls resolve immediately.
 */
export async function close() {
    if (closed)
        return;
    closed = true;
    try {
        const { promise, resolve } = Promise.withResolvers();
        winstonLogger.on("finish", resolve);
        winstonLogger.end();
        await promise;
    }
    catch {
        // Silently ignore logger close failures
    }
}
//# sourceMappingURL=logger.js.map