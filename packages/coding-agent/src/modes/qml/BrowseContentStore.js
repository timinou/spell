// BrowseContentStore.js — ephemeral key-value store for document tab content
// Content is NOT persisted across sessions; tabs restore as placeholders.
// LRU eviction prevents unbounded memory growth in long sessions.

var _store = {}
var _order = []
var _maxSize = 20

function get(key) {
    if (!key) return ""
    var value = _store[key]
    if (!value) return ""
    // Move to end (most recently used)
    var idx = _order.indexOf(key)
    if (idx >= 0) _order.splice(idx, 1)
    _order.push(key)
    return value
}

function set(key, value) {
    if (!key) return
    // Remove existing entry from order tracking
    var idx = _order.indexOf(key)
    if (idx >= 0) _order.splice(idx, 1)
    _store[key] = value || ""
    _order.push(key)
    // Evict oldest entries if over capacity
    while (_order.length > _maxSize) {
        var evicted = _order.shift()
        delete _store[evicted]
    }
}

function remove(key) {
    if (!key) return
    var idx = _order.indexOf(key)
    if (idx >= 0) _order.splice(idx, 1)
    delete _store[key]
}

function has(key) {
    return !!_store[key]
}

function size() {
    return _order.length
}
