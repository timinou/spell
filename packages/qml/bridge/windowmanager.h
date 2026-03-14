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

/**
 * Owns all active QML windows (one QQmlApplicationEngine per window).
 * Dispatches JSON commands from stdin or socket, writes JSON events
 * to stdout or via an injected event writer.
 */
class WindowManager : public QObject {
    Q_OBJECT

public:
    explicit WindowManager(QObject *parent = nullptr);
    ~WindowManager() override;

    /// Dispatch a JSON line received from stdin or socket.
    void dispatch(const QByteArray &jsonLine);

    /// Set an external event writer. If unset, events go to stdout.
    void setEventWriter(std::function<void(const QJsonObject&)> writer);

    /// Returns state of all windows as a JSON array of {id, path, state}.
    QJsonArray getWindowStates() const;

    struct WindowEntry {
        QQmlApplicationEngine *engine;
        Bridge *bridge;
        QString path;
        QString state; // "loading", "ready", "error", "closed"
        QStringList armedTools;
    };

private:
    void loadWindow(const QString &id, const QString &path, const QJsonObject &props,
                    int width, int height, const QString &title);
    void reloadWindow(const QString &id);
    void closeWindow(const QString &id);
    void sendMessage(const QString &id, const QJsonObject &payload);
    void screenshotWindow(const QString &id, const QString &savePath);
    void writeEvent(const QJsonObject &event);

    std::function<void(const QJsonObject&)> m_eventWriter;
    QHash<QString, WindowEntry> m_windows;
};
