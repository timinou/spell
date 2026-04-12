import QtQuick 2.15
import QtQuick.Controls 2.15
import SpellBridge.Native 1.0

ApplicationWindow {
    id: root
    visible: true
    width: 960
    height: 720
    title: "TypstDocumentItem Harness"

    property string sampleSource: "= Native Typst Surface\n\nThis document proves the Rust surface can render inside the QML bridge.\n\n- First bullet\n- Second bullet\n\n#image(\"assets/hero.png\")\n\n| Name | Value |\n| Surface | Ready |"

    TypstDocumentItem {
        id: documentSurface
        objectName: "typstSurface"
        anchors.fill: parent
        anchors.margins: 24
        source: root.sampleSource
    }

    Connections {
        target: documentSurface

        function onHitResolved(hit) {
            bridge.send({
                type: "surface_hit",
                hit: hit
            })
        }
    }

    Connections {
        target: bridge

        function onMessageReceived(payload) {
            if (payload.type === "query") {
                if (payload.query === "state") {
                    bridge.send({
                        type: "query_response",
                        query: payload.query,
                        result: {
                            ready: documentSurface.ready,
                            degraded: documentSurface.degraded,
                            capability: documentSurface.capability,
                            capabilityReason: documentSurface.capabilityReason,
                            statusMessage: documentSurface.statusMessage,
                            lastError: documentSurface.lastError,
                            svgLength: documentSurface.svgSnapshot.length,
                            blockCount: (documentSurface.stateSnapshot().blocks || []).length
                        }
                    })
                }
                if (payload.query === "hit") {
                    bridge.send({
                        type: "query_response",
                        query: payload.query,
                        result: documentSurface.hitTest(140, 120)
                    })
                }
            }

            if (payload.type === "set_source") {
                root.sampleSource = payload.source || root.sampleSource
            }

            if (payload.type === "set_force_degraded") {
                documentSurface.forceDegraded = Boolean(payload.value)
            }

            if (payload.type === "reset") {
                root.sampleSource = "= Native Typst Surface\n\nThis document proves the Rust surface can render inside the QML bridge.\n\n- First bullet\n- Second bullet\n\n#image(\"assets/hero.png\")\n\n| Name | Value |\n| Surface | Ready |"
                documentSurface.forceDegraded = false
                bridge.send({ type: "reset_done" })
            }
        }
    }
}
