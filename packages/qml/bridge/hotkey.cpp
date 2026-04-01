#include "hotkey.h"
#include <QDebug>

quint32 HotkeyManager::s_nextId = 1;

// ---------------------------------------------------------------------------
// macOS — Carbon RegisterEventHotKey
// ---------------------------------------------------------------------------
#ifdef Q_OS_MACOS
#include <Carbon/Carbon.h>

QHash<quint32, HotkeyManager *> HotkeyManager::s_carbonMap;
bool HotkeyManager::s_handlerInstalled = false;

// FourCharCode signature used to distinguish our hotkeys from others.
static const OSType kSpellSignature = 'SPEL';

static OSStatus carbonHotkeyHandler(EventHandlerCallRef /*callRef*/,
                                     EventRef event,
                                     void * /*userData*/) {
    EventHotKeyID hkid;
    if (GetEventParameter(event, kEventParamDirectObject,
                          typeEventHotKeyID, nullptr,
                          sizeof(hkid), nullptr, &hkid) != noErr)
        return eventNotHandledErr;

    if (hkid.signature != kSpellSignature)
        return eventNotHandledErr;

    HotkeyManager *mgr = HotkeyManager::s_carbonMap.value(hkid.id, nullptr);
    if (!mgr) return eventNotHandledErr;

    // Find the logical id for this native numeric id and emit the signal.
    for (auto it = mgr->m_hotkeys.constBegin(); it != mgr->m_hotkeys.constEnd(); ++it) {
        if (it->nativeKey == hkid.id) {   // we store the numeric id in nativeKey after registration
            emit mgr->hotkeyTriggered(it.key());
            return noErr;
        }
    }
    return eventNotHandledErr;
}

void HotkeyManager::installCarbonHandler() {
    if (s_handlerInstalled) return;
    EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
    InstallApplicationEventHandler(&carbonHotkeyHandler, 1, &spec, nullptr, nullptr);
    s_handlerInstalled = true;
}

// Map key name → Carbon virtual keycode (kVK_* constants from HIToolbox/Events.h).
static quint32 carbonKeyCode(const QString &key) {
    // Letters
    static const QHash<QString, quint32> table = {
        {"a", 0x00}, {"b", 0x0B}, {"c", 0x08}, {"d", 0x02}, {"e", 0x0E},
        {"f", 0x03}, {"g", 0x05}, {"h", 0x04}, {"i", 0x22}, {"j", 0x26},
        {"k", 0x28}, {"l", 0x25}, {"m", 0x2E}, {"n", 0x2D}, {"o", 0x1F},
        {"p", 0x23}, {"q", 0x0C}, {"r", 0x0F}, {"s", 0x01}, {"t", 0x11},
        {"u", 0x20}, {"v", 0x09}, {"w", 0x0D}, {"x", 0x07}, {"y", 0x10},
        {"z", 0x06},
        // Digits
        {"0", 0x1D}, {"1", 0x12}, {"2", 0x13}, {"3", 0x14}, {"4", 0x15},
        {"5", 0x17}, {"6", 0x16}, {"7", 0x1A}, {"8", 0x1C}, {"9", 0x19},
        // Function keys
        {"f1",  0x7A}, {"f2",  0x78}, {"f3",  0x63}, {"f4",  0x76},
        {"f5",  0x60}, {"f6",  0x61}, {"f7",  0x62}, {"f8",  0x64},
        {"f9",  0x65}, {"f10", 0x6D}, {"f11", 0x67}, {"f12", 0x6F},
        // Special
        {"space",  0x31}, {"tab",    0x30}, {"return", 0x24},
        {"escape", 0x35}, {"delete", 0x33}, {"backspace", 0x33},
        // Punctuation
        {"-", 0x1B}, {"=", 0x18}, {"[", 0x21}, {"]", 0x1E},
        {"\\", 0x2A}, {";", 0x29}, {"'", 0x27}, {",", 0x2B},
        {".", 0x2F}, {"/", 0x2C}, {"`", 0x32},
    };
    return table.value(key.toLower(), 0xFFFF);
}

// Map modifier name → Carbon modifier mask.
static quint32 carbonModMask(const QStringList &mods) {
    quint32 mask = 0;
    for (const QString &m : mods) {
        const QString lm = m.toLower();
        if (lm == "cmd" || lm == "meta")  mask |= cmdKey;
        else if (lm == "alt" || lm == "opt") mask |= optionKey;
        else if (lm == "ctrl")               mask |= controlKey;
        else if (lm == "shift")              mask |= shiftKey;
    }
    return mask;
}

HotkeyManager::HotkeyManager(QObject *parent) : QObject(parent) {}

HotkeyManager::~HotkeyManager() {
    unregisterAll();
}

bool HotkeyManager::registerHotkey(const QString &id, const QString &key,
                                    const QStringList &modifiers) {
    // Unregister first if already registered under this logical id.
    if (m_hotkeys.contains(id)) unregisterHotkey(id);

    quint32 keyCode = carbonKeyCode(key);
    if (keyCode == 0xFFFF) {
        qWarning() << "HotkeyManager: unknown key" << key;
        return false;
    }
    quint32 mods = carbonModMask(modifiers);

    quint32 numericId = s_nextId++;
    EventHotKeyID hkid = { kSpellSignature, numericId };
    EventHotKeyRef ref = nullptr;

    installCarbonHandler();

    OSStatus status = RegisterEventHotKey(keyCode, mods, hkid,
                                          GetApplicationEventTarget(),
                                          kEventHotKeyExclusive, &ref);
    if (status != noErr) {
        qWarning() << "HotkeyManager: RegisterEventHotKey failed, status=" << status;
        return false;
    }

    HotkeyEntry entry;
    entry.nativeKey  = numericId;   // store numeric id for reverse lookup
    entry.nativeMods = mods;
    entry.hotKeyRef  = ref;
    m_hotkeys.insert(id, entry);
    s_carbonMap.insert(numericId, this);
    return true;
}

void HotkeyManager::unregisterHotkey(const QString &id) {
    auto it = m_hotkeys.find(id);
    if (it == m_hotkeys.end()) return;
    if (it->hotKeyRef)
        UnregisterEventHotKey(static_cast<EventHotKeyRef>(it->hotKeyRef));
    s_carbonMap.remove(it->nativeKey);
    m_hotkeys.erase(it);
}

void HotkeyManager::unregisterAll() {
    for (auto it = m_hotkeys.begin(); it != m_hotkeys.end(); ++it) {
        if (it->hotKeyRef)
            UnregisterEventHotKey(static_cast<EventHotKeyRef>(it->hotKeyRef));
        s_carbonMap.remove(it->nativeKey);
    }
    m_hotkeys.clear();
}

// ---------------------------------------------------------------------------
// Linux — stub (Niri compositor owns hotkeys via its own IPC)
// ---------------------------------------------------------------------------
#elif defined(Q_OS_LINUX)

HotkeyManager::HotkeyManager(QObject *parent) : QObject(parent) {}
HotkeyManager::~HotkeyManager() {}

bool HotkeyManager::registerHotkey(const QString &id, const QString &key,
                                    const QStringList &modifiers) {
    Q_UNUSED(id); Q_UNUSED(key); Q_UNUSED(modifiers);
    qWarning() << "HotkeyManager: global hotkeys not supported on Linux "
                  "(register via the Niri IPC instead)";
    return false;
}

void HotkeyManager::unregisterHotkey(const QString &id) { Q_UNUSED(id); }
void HotkeyManager::unregisterAll() {}

// ---------------------------------------------------------------------------
// Other platforms — stub
// ---------------------------------------------------------------------------
#else

HotkeyManager::HotkeyManager(QObject *parent) : QObject(parent) {}
HotkeyManager::~HotkeyManager() {}

bool HotkeyManager::registerHotkey(const QString &id, const QString &key,
                                    const QStringList &modifiers) {
    Q_UNUSED(id); Q_UNUSED(key); Q_UNUSED(modifiers);
    qWarning() << "HotkeyManager: global hotkeys not supported on this platform";
    return false;
}

void HotkeyManager::unregisterHotkey(const QString &id) { Q_UNUSED(id); }
void HotkeyManager::unregisterAll() {}

#endif
