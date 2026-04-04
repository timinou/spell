#pragma once
#include <functional>
#include <QHash>
#include <QJsonArray>
#include <QStringList>
#include <QJsonObject>
#include <QObject>
#include <QQmlApplicationEngine>
#include <QQuickWindow>
#include <QString>
#include "bridge.h"
#include "systray.h"
#include "hotkey.h"
#include <QQuickItem>
#include <QLocalSocket>
#include <optional>

/**
 * Owns all active QML windows (one QQmlApplicationEngine per window).
 * Dispatches JSON commands from stdin or socket, writes JSON events
 * to stdout or via an injected event writer.
 *
 * In daemon (multi-client) mode each window has an owner client socket.
 * Events are routed only to the owning client, not broadcast.
 */
class WindowManager : public QObject {
    Q_OBJECT

public:
    explicit WindowManager(QObject *parent = nullptr);
    ~WindowManager() override;

    /// Dispatch a JSON line received from a specific client socket (nullptr = stdin mode).
    void dispatch(QLocalSocket *client, const QByteArray &jsonLine);

    /**
     * Set an external event writer.
     * client is the owning socket of the target window (nullptr = stdout mode).
     * If unset, events go to stdout.
     */
    void setEventWriter(std::function<void(QLocalSocket *, const QJsonObject &)> writer);

    /// Returns state of windows owned by or orphaned for the given client.
    /// In daemon mode, includes orphaned windows (owner == nullptr) with an "orphaned" flag.
    /// When client is nullptr (stdio mode), returns all windows.
    QJsonArray getWindowStates(QLocalSocket *client) const;

    /// Set owner to nullptr for all windows owned by the given (now-dead) client.
    void orphanWindows(QLocalSocket *deadClient);

    /// Claim orphaned windows (owner == nullptr) for a new client.
    /// Only claims windows whose id is in windowIds. Pass empty list to claim all.
    void claimOrphans(QLocalSocket *newClient, const QStringList &windowIds = {});

    struct WindowEntry {
        QQmlApplicationEngine *engine;
        Bridge *bridge;
        QString path;
        QString state; // "loading", "ready", "error", "closed"
        QStringList armedTools;
        QLocalSocket *owner = nullptr; // nullptr in stdio mode
    };

private:
    void loadWindow(QLocalSocket *client, const QString &id, const QString &path,
                    const QJsonObject &props, int width, int height, const QString &title);
    void reloadWindow(QLocalSocket *client, const QString &id);
    void closeWindow(QLocalSocket *client, const QString &id);
    void sendMessage(QLocalSocket *client, const QString &id, const QJsonObject &payload);
    void screenshotWindow(QLocalSocket *client, const QString &id, const QString &savePath);
    void queryItems(QLocalSocket *client, const QString &id, const QJsonObject &msg);
    void evalInWindow(QLocalSocket *client, const QString &id, const QString &expression);
    void clickInWindow(QLocalSocket *client, const QString &id, const QJsonObject &msg);
    void typeInWindow(QLocalSocket *client, const QString &id, const QString &text);
    void pressKeyInWindow(QLocalSocket *client, const QString &id,
                          const QString &key, const QString &modifiers);
    void scrollInWindow(QLocalSocket *client, const QString &id, const QJsonObject &msg);

    /// Write an event to a specific client (or stdout when client is nullptr).
    void writeEvent(QLocalSocket *client, const QJsonObject &event);
    /// Write an event to the owner of the named window. No-op if window unknown.
    void writeEventToOwner(const QString &windowId, const QJsonObject &event);

    struct QuerySelector {
        QString type;
        QString objectName;
        std::optional<bool> visible;
        QString textContains;
    };

    static QuerySelector parseSelector(const QJsonObject &sel);
    static bool matchesSelector(const QQuickItem *item, const QuerySelector &sel);
    static QJsonObject serializeItem(const QQuickItem *item, const QJsonArray &props,
                                     bool includeGeometry, const QString &path);
    static QJsonValue readProperty(const QObject *obj, const QString &name);
    static void walkTree(const QQuickItem *item, const QuerySelector &sel,
                         const QJsonArray &props, bool includeGeometry,
                         int maxDepth, int depth, const QString &path,
                         QJsonArray &results);

    SystrayManager *m_systray = nullptr;
    HotkeyManager *m_hotkey = nullptr;
    QLocalSocket *m_systrayOwner = nullptr;
    QLocalSocket *m_hotkeyOwner = nullptr;
    std::function<void(QLocalSocket *, const QJsonObject &)> m_eventWriter;
    QHash<QString, WindowEntry> m_windows;
};
