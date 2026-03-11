#pragma once
#include "bridge.h"
#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <functional>

class QQmlApplicationEngine;
class QQmlEngine;

/**
 * Manages the lifecycle of dynamically-loaded QML panels.
 * Each panel runs in its own QQmlApplicationEngine with a Bridge
 * injected as a context property — mirroring the desktop WindowManager
 * but keyed by server-assigned panel id rather than a file path.
 */
class PanelManager : public QObject {
    Q_OBJECT

public:
    explicit PanelManager(QQmlEngine *hostEngine, QObject *parent = nullptr);
    ~PanelManager();

    /**
     * Wire outbound events (panel_ready, panel_event, panel_error, panel_closed)
     * back to RemoteClient::sendPanelEvent. Called once from main.cpp.
     */
    void setSendEvent(std::function<void(const QJsonObject &)> fn);

signals:
    void panelLoaded(QString id);
    void panelClosed(QString id);
    void panelError(QString id, QString message);

public slots:
    Q_INVOKABLE void handleCommand(const QJsonObject &data);

private:
    struct PanelEntry {
        QQmlApplicationEngine *engine = nullptr;
        Bridge *bridge = nullptr;
        QString id;
        QString qmlPath; // path to written .qml file in app-local storage
    };

    void pushQml(const QString &id, const QString &content,
                 const QJsonObject &props, const QString &title,
                 int width, int height);
    void closePanel(const QString &id, bool sendUpstream);
    void sendEvent(const QJsonObject &data);

    QQmlEngine *m_hostEngine; // used only to inherit import paths if needed
    QHash<QString, PanelEntry> m_panels;
    std::function<void(const QJsonObject &)> m_sendEvent;
    QString m_panelCacheDir;
};
