#pragma once
#include <QJsonObject>
#include <QObject>
#include <QString>

/**
 * QObject injected into each QML context as `bridge`.
 * QML calls bridge.send({...}) to emit events back to omp.
 * omp sends messages via bridge.messageReceived signal.
 */
class Bridge : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject props READ props NOTIFY propsChanged)

public:
    explicit Bridge(const QString &windowId, QObject *parent = nullptr);

    QJsonObject props() const { return m_props; }
    void setProps(const QJsonObject &props);

    // Called by WindowManager when omp sends a message to this window
    void deliverMessage(const QJsonObject &payload);

signals:
    void propsChanged();
    // Fired when omp sends a message — QML connects to this
    void messageReceived(QJsonObject payload);
    // Internal: fired when QML calls send(), picked up by WindowManager
    void eventEmitted(const QString &windowId, const QJsonObject &payload);

public:
    // Q_INVOKABLE so QML can call bridge.send({...})
    Q_INVOKABLE void send(const QJsonObject &payload);

private:
    QString m_windowId;
    QJsonObject m_props;
};
