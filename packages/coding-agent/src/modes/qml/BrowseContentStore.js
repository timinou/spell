// BrowseContentStore.js — ephemeral key-value store for document tab content
// Content is NOT persisted across sessions; tabs restore as placeholders.

var _store = {}

function get(key) {
    if (!key) return ""
    return _store[key] || ""
}

function set(key, value) {
    if (!key) return
    _store[key] = value || ""
}

function remove(key) {
    if (!key) return
    delete _store[key]
}

function has(key) {
    return !!_store[key]
}
