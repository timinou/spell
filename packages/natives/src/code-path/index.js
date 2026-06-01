import { native } from "../native";
export function listOps() {
    return native.listOps();
}
export async function executeCodePath(options) {
    return native.executeCodePath(options);
}
export function parseCodePath(target) {
    return native.parseCodePath(target);
}
export function renderCodePath(ast) {
    return native.renderCodePath(ast);
}
export function getRegisteredExtensions() {
    return native.getRegisteredExtensions();
}
export function listOpKinds() {
    return native.listOpKinds();
}
export function listQualifiers() {
    return native.listQualifiers();
}
export function listEdgeKinds() {
    return native.listEdgeKinds();
}
export function listDiagnosticVariants() {
    return native.listDiagnosticVariants();
}
export function listLanguageDialects() {
    return native.listLanguageDialects();
}
// PLAN-310: dynamic scheme registration helpers.
//
// Callbacks MUST return synchronously — the underlying napi
// ThreadsafeFunction calls back into JS from a kernel worker thread and
// blocks on an mpsc channel for the return value. Async returns (Promise)
// fail napi-rs field deserialization. For naturally-async I/O, prefer
// sync variants (fs.readFileSync) inside callbacks.
export function registerSchemeCallback(scheme, callback, options) {
    native.registerSchemeCallback(scheme, (err, body) => {
        if (err)
            throw err;
        return callback(body);
    }, options);
}
export function unregisterSchemeCallback(scheme) {
    return native.unregisterSchemeCallback(scheme);
}
export function listRegisteredSchemes() {
    return native.listRegisteredSchemes();
}
export function clearRuntimeSchemes() {
    native.clearRuntimeSchemes();
}
//# sourceMappingURL=index.js.map