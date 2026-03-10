#pragma once
#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QQmlApplicationEngine>
#include <QString>
#include "bridge.h"

/**
 * Owns all active QML windows (one QQmlApplicationEngine per window).
 * Dispatches JSON commands from stdin, writes JSON events to stdout.
 */
class WindowManager : public QObject {
    Q_OBJECT

public:
    explicit WindowManager(QObject *parent = nullptr);
    ~WindowManager() override;

    // Dispatch a JSON line received from stdin
    void dispatch(const QByteArray &jsonLine);

private:
    void loadWindow(const QString &id, const QString &path, const QJsonObject &props,
                    int width, int height, const QString &title);
    void reloadWindow(const QString &id);
    void closeWindow(const QString &id);
    void sendMessage(const QString &id, const QJsonObject &payload);
    void writeEvent(const QJsonObject &event);

    struct WindowEntry {
        QQmlApplicationEngine *engine;
        Bridge *bridge;
        QString path;
    };
    QHash<QString, WindowEntry> m_windows;
};
