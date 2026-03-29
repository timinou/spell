import QtQuick 2.15

Item {
    id: root

    required property string msgId
    required property string role
    required property string text
    required property string thinking
    required property string name
    required property bool isStreaming
    required property bool isExpanded
    required property int index
    required property bool isError
    required property string title
    required property string url
    required property string excerpt
    required property string tagsText
    required property string tabId
    required property string sourceType
    required property string query
    required property string sourcesJson
    required property string collapsed

    signal toggleExpanded(int index)
    signal viewInTab(string tabId, string url, string title)

    width: ListView.view ? ListView.view.width - ListView.view.leftMargin - ListView.view.rightMargin : (parent ? parent.width : 0)
    implicitHeight: delegateLoader.item ? delegateLoader.item.implicitHeight : 0

    Loader {
        id: delegateLoader
        width: parent.width
        sourceComponent: {
            if (root.role === "user") return userComponent
            if (root.role === "tool") return toolComponent
            if (root.role === "image") return imageComponent
            if (root.role === "finding") return findingComponent
            if (root.role === "search_group") return searchGroupComponent
            return assistantComponent
        }
    }

    Component {
        id: assistantComponent

        FlowAssistant {
            width: root.width
            text: root.text
            thinking: root.thinking
            isStreaming: root.isStreaming
            showSeparator: root.index > 0
        }
    }

    Component {
        id: userComponent

        FlowUser {
            width: root.width
            text: root.text
            showSeparator: root.index > 0
        }
    }

    Component {
        id: toolComponent

        FlowTool {
            width: root.width
            text: root.text
            name: root.name
            isStreaming: root.isStreaming
            isExpanded: root.isExpanded
            isError: root.isError
            messageIndex: root.index
            showSeparator: root.index > 0
            onToggleExpanded: function(index) {
                root.toggleExpanded(index)
            }
        }
    }

    Component {
        id: imageComponent

        FlowImage {
            width: root.width
            text: root.text
            name: root.name
            showSeparator: root.index > 0
        }
    }

    Component {
        id: findingComponent

        FindingCard {
            sourceType: root.sourceType
            width: root.width
            url: root.url
            title: root.title
            excerpt: root.excerpt
            tagsText: root.tagsText
            tabId: root.tabId
            showSeparator: root.index > 0
            onViewInTab: function(tabId, url, title) {
                root.viewInTab(tabId, url, title)
            }
        }
    }

    Component {
        id: searchGroupComponent

        SearchGroupDelegate {
            width: root.width
            query: root.query
            sourcesJson: root.sourcesJson
            collapsed: root.collapsed
            index: root.index
            showSeparator: root.index > 0
            onViewInTab: function(tabId, url, title) {
                root.viewInTab(tabId, url, title)
            }
            onToggleCollapsed: function(index) {
                root.toggleExpanded(index)
            }
        }
    }
}
