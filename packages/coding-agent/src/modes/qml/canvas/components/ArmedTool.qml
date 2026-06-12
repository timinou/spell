import QtQuick 2.15

// ArmedTool — correlation helper for the canvas armed-tool round-trip (FUP-127).
//
// The native `bridge` exposes only `send(payload)` (QML → host) and a
// `messageReceived(payload)` signal (host → QML). Every tile that invokes an
// armed tool otherwise has to hand-roll request/response correlation: pick a
// unique `_rid`, `bridge.send({_tool, _rid, ...})`, then match `payload._rid`
// in its own `onMessageReceived`. That boilerplate is error-prone (rid
// collisions, leaked handlers, lost replies, no timeout).
//
// This component owns that correlation. A tile writes:
//
//     ArmedTool { id: armed }
//     ...
//     armed.invoke("execute",
//         { program: tile.program, mode: "write", intent: "visible-refresh" },
//         function (reply) {
//             // success: reply.result (text), reply.details (structured — FUP-126)
//             //          e.g. reply.details.transaction.{outcome,files,paths}
//         },
//         function (err) {
//             // failure: err.message, err.code ("not-allowed"|"not-found"|
//             //          "threw"|"timeout") — FUP-128
//         })
//
// It MUST be fed host messages: place a Connections block on `bridge` in the
// tile and forward every payload to `route(payload)`. `route` returns true if
// it consumed the payload (it was a reply to an in-flight invoke) so the tile
// can skip its own handling, or false to let non-invoke messages flow through.
//
//     Connections {
//         target: (typeof bridge !== "undefined") ? bridge : null
//         function onMessageReceived(payload) {
//             if (armed.route(payload)) return   // consumed an armed-tool reply
//             canvas.handleMessage(payload)      // normal protocol message
//         }
//     }
//
// Callback form (not Promise) is the primitive deliberately: it works across
// every Qt6 QML JS engine without relying on async/await support in the tile
// context. A Promise wrapper can be layered on top where the engine supports it.

QtObject {
    id: root

    // Default per-invoke timeout (ms). A reply that never arrives rejects with
    // code "timeout" after this budget so a tile never hangs on a lost reply.
    property int defaultTimeoutMs: 30000

    // Internal: monotonic sequence + the pending request table keyed by _rid.
    property int _seq: 0
    property var _pending: ({})   // rid -> { onResult, onError, timer }

    // invoke(tool, args, onResult, onError, timeoutMs?)
    //   tool      armed tool name (must be in the window's spellArmedTools)
    //   args      plain object of tool arguments (protocol fields added here)
    //   onResult  function(reply) on success; reply = { result, details, data }
    //   onError   function(err)   on failure; err = { message, code }
    //   timeoutMs optional override of defaultTimeoutMs
    function invoke(tool, args, onResult, onError, timeoutMs) {
        if (typeof bridge === "undefined" || !bridge) {
            if (onError) onError({ message: "bridge unavailable", code: "threw" })
            return null
        }
        root._seq += 1
        var rid = "inv-" + root._seq + "-" + Date.now()

        // Qt's QML JS Date.now()/setTimeout: use a Timer child for the budget.
        var budget = (timeoutMs && timeoutMs > 0) ? timeoutMs : root.defaultTimeoutMs
        var timer = _timerComponent.createObject(root, { interval: budget })
        var entry = { onResult: onResult, onError: onError, timer: timer }

        // Mutate a fresh copy so QML property-binding observers see the change.
        var next = {}
        for (var k in root._pending) next[k] = root._pending[k]
        next[rid] = entry
        root._pending = next

        timer.triggered.connect(function () {
            // Fire once; reject with timeout and clean up.
            var e = root._pending[rid]
            if (!e) return
            root._forget(rid)
            if (e.onError) e.onError({ message: "armed tool timeout: " + tool, code: "timeout" })
        })
        timer.start()

        // Build the wire payload: protocol fields + caller args.
        var payload = { _tool: tool, _rid: rid }
        if (args) {
            for (var ak in args) {
                if (ak !== "_tool" && ak !== "_rid") payload[ak] = args[ak]
            }
        }
        bridge.send(payload)
        return rid
    }

    // route(payload) — feed every host message here. Returns true if the payload
    // was a reply to an in-flight invoke (and was dispatched), false otherwise.
    function route(payload) {
        if (!payload || typeof payload._rid !== "string") return false
        var entry = root._pending[payload._rid]
        if (!entry) return false   // not ours — let the tile handle it
        root._forget(payload._rid)
        // Failure shape: { error, code }. Success shape: { result, details, data }.
        if (payload.error) {
            if (entry.onError) {
                entry.onError({
                    message: String(payload.error),
                    code: (typeof payload.code === "string") ? payload.code : "threw"
                })
            }
        } else {
            if (entry.onResult) {
                entry.onResult({
                    result: (typeof payload.result === "string") ? payload.result : "",
                    details: (payload.details !== undefined) ? payload.details : null,
                    data: (payload.data !== undefined) ? payload.data : null
                })
            }
        }
        return true
    }

    // _forget — remove a pending entry and tear down its timer.
    function _forget(rid) {
        var entry = root._pending[rid]
        if (!entry) return
        if (entry.timer) {
            entry.timer.stop()
            entry.timer.destroy()
        }
        var next = {}
        for (var k in root._pending) {
            if (k !== rid) next[k] = root._pending[k]
        }
        root._pending = next
    }

    // Lazily-instantiated single-shot Timer factory (one per in-flight invoke).
    property var _timerComponent: Component {
        Timer { repeat: false }
    }
}
