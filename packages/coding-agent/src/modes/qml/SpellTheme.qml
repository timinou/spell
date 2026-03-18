pragma Singleton
import QtQuick 2.15

QtObject {
    // Surface tonal palette (dark mode)
    readonly property color background: "#0d1117"
    readonly property color surface0: "#151b23"
    readonly property color surface1: "#1e252e"
    readonly property color surface2: "#2a3240"
    readonly property color borderSubtle: "#253040"
    readonly property color borderDefault: "#3a4556"
    readonly property color borderStrong: "#4f5d73"

    // @deprecated: keep original values for out-of-scope consumers
    readonly property color surface: "#161b22"
    // @deprecated: keep original values for out-of-scope consumers
    readonly property color surfaceHigh: "#1c2129"
    // @deprecated: keep original values for out-of-scope consumers
    readonly property color surfaceHigher: "#242a33"
    // @deprecated: keep original values for out-of-scope consumers
    readonly property color outline: "#30363d"
    // @deprecated: keep original values for out-of-scope consumers
    readonly property color outlineVariant: "#21262d"

    // Content
    readonly property color textPrimary: "#e6edf3"
    readonly property color textSecondary: "#8b949e"
    readonly property color textTertiary: "#6e7681"
    readonly property color textGhost: "#484f58"

    // Primary accent
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
    readonly property int fontSizeXS: 11
    readonly property int fontSizeS: 12
    readonly property int fontSizeCaption: 13
    readonly property int fontSizeM: 14
    readonly property int fontSizeL: 16
    readonly property int fontSizeXL: 20
    readonly property int fontSizeXXL: 26
    readonly property int fontWeightLight: Font.Light
    readonly property int fontWeightRegular: Font.Normal
    readonly property int fontWeightMedium: Font.Medium
    readonly property int fontWeightSemiBold: Font.DemiBold
    readonly property int fontWeightBold: Font.Bold
    readonly property real trackingTight: -0.3
    readonly property real trackingNormal: 0
    readonly property real trackingWide: 0.5
    readonly property real lineHeightBody: 1.5
    readonly property real lineHeightHeading: 1.25
    readonly property real lineHeightMono: 1.6

    // @deprecated: use fontSizeS
    readonly property int fontSizeSmall: 12
    // @deprecated: use fontSizeM
    readonly property int fontSizeMedium: 14
    // @deprecated: use fontSizeL
    readonly property int fontSizeLarge: 16
    // @deprecated: use fontSizeXL
    readonly property int fontSizeTitle: 20

    // Corner radii
    readonly property int cornerRadius: 8
    readonly property int cornerRadiusLarge: 16
    readonly property int cornerRadiusSmall: 4

    // Animation
    readonly property int durationFast: 80
    readonly property int durationNormal: 150
    readonly property int durationMedium: 250
    // @deprecated: use durationNormal
    readonly property int shortDuration: 150
    // @deprecated: use durationMedium
    readonly property int mediumDuration: 250

    function withAlpha(color, alpha) {
        return Qt.rgba(color.r, color.g, color.b, alpha)
    }

    function diffAddBg() {
        return Qt.rgba(46 / 255, 160 / 255, 67 / 255, 0.15)
    }

    function diffRemoveBg() {
        return Qt.rgba(248 / 255, 81 / 255, 73 / 255, 0.15)
    }

    function diffHunkBg() {
        return Qt.rgba(56 / 255, 139 / 255, 253 / 255, 0.10)
    }
}
