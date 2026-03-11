import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: root
    title: "Brand Asset Gallery"
    width: 1100
    height: 760
    visible: true
    color: "#111318"

    // ── State ──────────────────────────────────────────────────────────────
    property string detailImageId: ""
    property string feedbackText: ""

    Component.onCompleted: {
        const imgs = bridge.props["images"];
        if (imgs) loadImages(imgs);
    }

    function loadImages(imgs) {
        listModel.clear();
        for (const img of imgs) {
            listModel.append({
                imgId:     img.id,
                imgPath:   img.path,
                imgPrompt: img.prompt   ?? "",
                imgRating: img.rating   ?? 0,
                imgSel:    img.selected ?? false
            });
        }
    }

    function findIndex(id) {
        for (let i = 0; i < listModel.count; i++)
            if (listModel.get(i).imgId === id) return i;
        return -1;
    }

    function anySelected() {
        for (let i = 0; i < listModel.count; i++)
            if (listModel.get(i).imgSel) return true;
        return false;
    }

    // ── Bridge message handler ─────────────────────────────────────────────
    Connections {
        target: bridge
        function onMessageReceived(payload) {
            const action = payload["action"];
            if (action === "add_images") {
                const imgs = payload["images"] ?? [];
                for (const img of imgs) {
                    listModel.append({
                        imgId:     img.id,
                        imgPath:   img.path,
                        imgPrompt: img.prompt   ?? "",
                        imgRating: img.rating   ?? 0,
                        imgSel:    img.selected ?? false
                    });
                }
                toast.show("Added " + imgs.length + " image" + (imgs.length !== 1 ? "s" : ""));
            } else if (action === "remove_image") {
                const idx = root.findIndex(payload["id"]);
                if (idx >= 0) listModel.remove(idx);
            } else if (action === "set_rating") {
                const idx = root.findIndex(payload["id"]);
                if (idx >= 0) listModel.setProperty(idx, "imgRating", payload["rating"]);
            } else if (action === "notify") {
                toast.show(payload["message"] ?? "");
            }
        }
    }

    ListModel { id: listModel }

    // ── Layout ─────────────────────────────────────────────────────────────
    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Top bar
        Rectangle {
            Layout.fillWidth: true
            height: 52
            color: "#1a1d24"

            RowLayout {
                anchors { fill: parent; leftMargin: 16; rightMargin: 16 }
                spacing: 8

                Text {
                    text: listModel.count + " asset" + (listModel.count !== 1 ? "s" : "")
                    color: "#8b95a8"
                    font.pixelSize: 13
                }

                Item { Layout.fillWidth: true }

                // Generate More
                Rectangle {
                    width: genMoreLabel.implicitWidth + 24; height: 32; radius: 6
                    color: genMoreArea.containsMouse ? "#2a5aad" : "#1e4a9a"
                    Text { id: genMoreLabel; anchors.centerIn: parent; text: "Generate More"; color: "white"; font.pixelSize: 13 }
                    MouseArea { id: genMoreArea; anchors.fill: parent; hoverEnabled: true
                        onClicked: bridge.send({ action: "generate_more", count: 4 }) }
                }

                // Export Selected
                Rectangle {
                    id: exportRect
                    property bool canExport: root.anySelected()
                    width: exportLabel.implicitWidth + 24; height: 32; radius: 6
                    color: exportRect.canExport ? (exportArea.containsMouse ? "#3a7d44" : "#2d6636") : "#2a2e38"
                    Text { id: exportLabel; anchors.centerIn: parent; text: "Export Selected"
                        color: exportRect.canExport ? "white" : "#555e70"; font.pixelSize: 13 }
                    MouseArea { id: exportArea; anchors.fill: parent; hoverEnabled: true; enabled: exportRect.canExport
                        onClicked: {
                            const ids = [];
                            for (let i = 0; i < listModel.count; i++)
                                if (listModel.get(i).imgSel) ids.push(listModel.get(i).imgId);
                            bridge.send({ action: "export", ids: ids, directory: "" });
                        }
                    }
                    // Re-evaluate canExport whenever listModel changes
                    Connections { target: listModel; function onCountChanged() { exportRect.canExport = root.anySelected() } }
                    Connections { target: listModel; function onDataChanged() { exportRect.canExport = root.anySelected() } }
                }

                // Close
                Rectangle {
                    width: closeLabel.implicitWidth + 24; height: 32; radius: 6
                    color: closeArea.containsMouse ? "#5c2a2a" : "#3a1e1e"
                    Text { id: closeLabel; anchors.centerIn: parent; text: "✕ Close"; color: "#e07070"; font.pixelSize: 13 }
                    MouseArea { id: closeArea; anchors.fill: parent; hoverEnabled: true
                        onClicked: { bridge.send({ action: "close" }); Qt.quit() } }
                }
            }
        }

        // Grid
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: gridView.width

            GridView {
                id: gridView
                width: parent.width
                topMargin: 16; bottomMargin: 16; leftMargin: 16; rightMargin: 16
                model: listModel

                property int cols: Math.max(1, Math.floor((width - 32) / 280))
                cellWidth: Math.floor((width - 32) / cols)
                cellHeight: cellWidth + 96

                delegate: Item {
                    id: delegateItem
                    width: gridView.cellWidth
                    height: gridView.cellHeight

                    readonly property string cardId:     model.imgId
                    readonly property int    cardIndex:  index
                    readonly property int    cardRating: model.imgRating
                    readonly property bool   cardSel:    model.imgSel

                    Rectangle {
                        anchors { fill: parent; margins: 8 }
                        color: "#1a1d24"
                        radius: 10
                        border.color: delegateItem.cardSel ? "#2a5aad" : imgArea.containsMouse ? "#2f3546" : "transparent"
                        border.width: delegateItem.cardSel ? 2 : 1

                        ColumnLayout {
                            anchors.fill: parent
                            spacing: 0

                            // ── Image ──────────────────────────────────────
                            Item {
                                Layout.fillWidth: true
                                Layout.fillHeight: true

                                Image {
                                    id: cardImg
                                    anchors { fill: parent; margins: 8 }
                                    source: "file://" + model.imgPath
                                    fillMode: Image.PreserveAspectCrop
                                    asynchronous: true; smooth: true

                                    Rectangle {
                                        anchors.fill: parent; color: "#0d0f14"
                                        visible: cardImg.status !== Image.Ready
                                        Text {
                                            anchors.centerIn: parent
                                            text: cardImg.status === Image.Loading ? "Loading…" : "⚠ Failed"
                                            color: "#555e70"; font.pixelSize: 12
                                        }
                                    }
                                }

                                MouseArea {
                                    id: imgArea
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    propagateComposedEvents: true
                                    onClicked: root.detailImageId = delegateItem.cardId
                                }

                                // Selection checkbox
                                Rectangle {
                                    anchors { top: parent.top; right: parent.right; margins: 14 }
                                    width: 22; height: 22; radius: 4
                                    color: delegateItem.cardSel ? "#2a5aad" : "#0d0f14"
                                    border.color: delegateItem.cardSel ? "#4a7acd" : "#3a3f50"
                                    Text {
                                        anchors.centerIn: parent; text: "✓"; color: "white"
                                        font.pixelSize: 13; visible: delegateItem.cardSel
                                    }
                                    MouseArea {
                                        anchors.fill: parent
                                        onClicked: {
                                            const newVal = !listModel.get(delegateItem.cardIndex).imgSel;
                                            listModel.setProperty(delegateItem.cardIndex, "imgSel", newVal);
                                            bridge.send({ action: "select", id: delegateItem.cardId, selected: newVal });
                                        }
                                    }
                                }
                            }

                            // ── Controls strip ─────────────────────────────
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Layout.leftMargin: 10; Layout.rightMargin: 10
                                Layout.topMargin: 6;   Layout.bottomMargin: 8

                                // Stars
                                Row {
                                    spacing: 2
                                    Repeater {
                                        model: 5
                                        delegate: Item {
                                            id: starItem
                                            readonly property int    starN:      index + 1
                                            readonly property string ownCardId:  delegateItem.cardId
                                            readonly property int    ownCardIdx: delegateItem.cardIndex
                                            readonly property int    curRating:  delegateItem.cardRating
                                            width: 22; height: 22
                                            Text {
                                                anchors.centerIn: parent
                                                text: starItem.starN <= starItem.curRating ? "★" : "☆"
                                                color: starItem.starN <= starItem.curRating ? "#f0b429" : "#3a3f50"
                                                font.pixelSize: 18
                                            }
                                            MouseArea {
                                                anchors.fill: parent
                                                onClicked: {
                                                    listModel.setProperty(starItem.ownCardIdx, "imgRating", starItem.starN);
                                                    bridge.send({ action: "rate", id: starItem.ownCardId, rating: starItem.starN });
                                                }
                                            }
                                        }
                                    }
                                }

                                // Regenerate
                                Rectangle {
                                    Layout.fillWidth: true; height: 28; radius: 5
                                    color: regenArea.containsMouse ? "#2f3546" : "#232733"
                                    Text {
                                        anchors.centerIn: parent; text: "Regenerate"
                                        color: "#8b95a8"; font.pixelSize: 12
                                    }
                                    MouseArea {
                                        id: regenArea; anchors.fill: parent; hoverEnabled: true
                                        onClicked: bridge.send({
                                            action: "regenerate",
                                            ids: [delegateItem.cardId],
                                            feedback: root.feedbackText
                                        })
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Feedback bar
        Rectangle {
            Layout.fillWidth: true
            height: 52
            color: "#1a1d24"

            RowLayout {
                anchors { fill: parent; leftMargin: 16; rightMargin: 16 }
                spacing: 10

                Text { text: "Direction:"; color: "#555e70"; font.pixelSize: 13 }

                TextField {
                    id: feedbackField
                    Layout.fillWidth: true
                    placeholderText: "e.g. more blue, less busy, rounder corners…"
                    color: "#d0d6e0"; font.pixelSize: 13
                    background: Rectangle {
                        color: "#0d0f14"; radius: 6
                        border.color: feedbackField.activeFocus ? "#2a5aad" : "#2f3546"
                    }
                    onTextChanged: root.feedbackText = text
                }

                // Apply to Selected
                Rectangle {
                    id: applyRect
                    property bool canApply: feedbackField.text.trim().length > 0
                    width: applyLabel.implicitWidth + 24; height: 32; radius: 6
                    color: applyRect.canApply ? (applyArea.containsMouse ? "#2a5aad" : "#1e4a9a") : "#2a2e38"
                    Text { id: applyLabel; anchors.centerIn: parent; text: "Apply to Selected"
                        color: applyRect.canApply ? "white" : "#555e70"; font.pixelSize: 13 }
                    MouseArea { id: applyArea; anchors.fill: parent; hoverEnabled: true; enabled: applyRect.canApply
                        onClicked: {
                            const ids = [];
                            for (let i = 0; i < listModel.count; i++)
                                if (listModel.get(i).imgSel) ids.push(listModel.get(i).imgId);
                            bridge.send({ action: "regenerate", ids: ids, feedback: feedbackField.text.trim() });
                        }
                    }
                }
            }
        }
    }

    // ── Detail overlay ─────────────────────────────────────────────────────
    Rectangle {
        id: detailOverlay
        anchors.fill: parent
        color: "#e0111318"
        visible: root.detailImageId !== ""
        z: 10

        MouseArea { anchors.fill: parent; onClicked: root.detailImageId = "" }

        Flickable {
            anchors { fill: parent; margins: 40 }
            contentWidth: detailImg.sourceSize.width
            contentHeight: detailImg.sourceSize.height
            clip: true
            boundsMovement: Flickable.StopAtBounds

            Image {
                id: detailImg
                width: Math.min(detailOverlay.width - 80, 900)
                height: Math.min(detailOverlay.height - 80, 900)
                fillMode: Image.PreserveAspectFit
                asynchronous: true; smooth: true
                source: {
                    if (root.detailImageId === "") return "";
                    const idx = root.findIndex(root.detailImageId);
                    return idx >= 0 ? "file://" + listModel.get(idx).imgPath : "";
                }
                MouseArea { anchors.fill: parent }
            }
        }

        // Close overlay button
        Rectangle {
            anchors { top: parent.top; right: parent.right; margins: 12 }
            width: 36; height: 36; radius: 18
            color: detailCloseArea.containsMouse ? "#5c2a2a" : "#2a2e38"
            Text { anchors.centerIn: parent; text: "✕"; color: "#e07070"; font.pixelSize: 16 }
            MouseArea { id: detailCloseArea; anchors.fill: parent; hoverEnabled: true
                onClicked: root.detailImageId = "" }
        }
    }

    // ── Toast ──────────────────────────────────────────────────────────────
    Item {
        id: toast
        anchors { bottom: parent.bottom; horizontalCenter: parent.horizontalCenter; bottomMargin: 70 }
        z: 20; opacity: 0

        function show(msg) { toastText.text = msg; toastAnim.restart() }

        SequentialAnimation {
            id: toastAnim
            PropertyAction   { target: toast; property: "opacity"; value: 0 }
            PropertyAnimation { target: toast; property: "opacity"; to: 1; duration: 150 }
            PauseAnimation   { duration: 2200 }
            PropertyAnimation { target: toast; property: "opacity"; to: 0; duration: 300 }
        }

        Rectangle {
            anchors.centerIn: parent
            width: toastText.implicitWidth + 32; height: 36; radius: 18; color: "#2a2e38"
            Text { id: toastText; anchors.centerIn: parent; color: "#d0d6e0"; font.pixelSize: 13 }
        }
    }
}
