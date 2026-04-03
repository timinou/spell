import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Window 2.15
Window {
	visible: true
	width: 820
	height: 480
	color: "#111827"
	Rectangle {
		anchors.fill: parent
		color: "#111827"
		Column {
			anchors.fill: parent
			anchors.margins: 24
			spacing: 12
			Text { text: "Approval / Checkpoint Surface"; color: "#f9fafb"; font.pixelSize: 28; font.bold: true }
		Text { text: "Pending: 0"; color: "white"; font.pixelSize: 18; wrapMode: Text.Wrap }
		Text { text: "Completed: 2"; color: "white"; font.pixelSize: 18; wrapMode: Text.Wrap }
		Text { text: "approval approval-1 :: Approve digest :: feed-approved :: "; color: "white"; font.pixelSize: 18; wrapMode: Text.Wrap }
		Text { text: "checkpoint checkpoint-2 :: Export checkpoint :: completed :: "; color: "white"; font.pixelSize: 18; wrapMode: Text.Wrap }
		}
	}
}
