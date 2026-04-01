#pragma once
#include <QHash>
#include <QObject>
#include <QString>
#include <QStringList>

/**
 * Platform-aware global hotkey registration.
 * - macOS: Carbon RegisterEventHotKey (no Accessibility permission needed)
 * - Linux/X11: stub — Niri compositor owns hotkeys via IPC
 * - Linux/Wayland: no-op (compositor handles hotkeys)
 */
class HotkeyManager : public QObject {
    Q_OBJECT
public:
    explicit HotkeyManager(QObject *parent = nullptr);
    ~HotkeyManager() override;

    /// Register a global hotkey. Returns true on success.
    bool registerHotkey(const QString &id, const QString &key, const QStringList &modifiers);
    /// Unregister a specific hotkey by its logical id.
    void unregisterHotkey(const QString &id);
    /// Unregister all hotkeys.
    void unregisterAll();

signals:
    void hotkeyTriggered(const QString &id);

private:
    struct HotkeyEntry {
        quint32 nativeKey;
        quint32 nativeMods;
#ifdef Q_OS_MACOS
        void *hotKeyRef = nullptr; // EventHotKeyRef
#endif
    };
    QHash<QString, HotkeyEntry> m_hotkeys;
    static quint32 s_nextId;

#ifdef Q_OS_MACOS
    static QHash<quint32, HotkeyManager *> s_carbonMap;
    static bool s_handlerInstalled;
    void installCarbonHandler();
#endif
};
