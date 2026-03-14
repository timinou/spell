pragma Singleton
import QtQuick 2.15

QtObject {
    // Surface tonal palette (dark mode)
    readonly property color background: "#0e1117"
    readonly property color surface: "#161b22"
    readonly property color surfaceHigh: "#1c2129"
    readonly property color surfaceHigher: "#242a33"
    readonly property color outline: "#30363d"
    readonly property color outlineVariant: "#21262d"

    // Content
    readonly property color textPrimary: "#e6edf3"
    readonly property color textSecondary: "#8b949e"
    readonly property color textTertiary: "#484f58"

    // Primary accent — changed from purple to amber
    readonly property color primary: "#e8a040"
    readonly property color primaryText: "#ffffff"
    readonly property color primaryContainer: "#3d2800"

    // Semantic
    readonly property color error: "#f85149"
    readonly property color success: "#3fb950"
    readonly property color warning: "#d29922"

    // State opacities
    readonly property real hoverOpacity: 0.08
    readonly property real pressOpacity: 0.12
    readonly property real disabledOpacity: 0.38

    // Spacing
    readonly property int spacingXS: 4
    readonly property int spacingS: 8
    readonly property int spacingM: 12
    readonly property int spacingL: 16
    readonly property int spacingXL: 24

    // Typography
    readonly property string fontFamily: "Inter"
    readonly property string monoFontFamily: "Fira Code"
    readonly property int fontSizeSmall: 12
    readonly property int fontSizeMedium: 14
    readonly property int fontSizeLarge: 16
    readonly property int fontSizeTitle: 20

    // Corner radii
    readonly property int cornerRadius: 8
    readonly property int cornerRadiusLarge: 16
    readonly property int cornerRadiusSmall: 4

    // Animation
    readonly property int shortDuration: 150
    readonly property int mediumDuration: 250

    function withAlpha(color, alpha) {
        return Qt.rgba(color.r, color.g, color.b, alpha)
    }
}
