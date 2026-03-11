#pragma once
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QTimer>
#include <QWebSocket>

/**
 * Manages the WebSocket connection to the omp server.
 * Parses incoming JSON messages and dispatches by channel.
 * Reconnects automatically with exponential backoff unless
 * disconnect() was called intentionally.
 */
class RemoteClient : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool connected READ connected NOTIFY connectedChanged)
    Q_PROPERTY(QString serverUrl READ serverUrl WRITE setServerUrl)

public:
    explicit RemoteClient(QObject *parent = nullptr);

    bool connected() const { return m_connected; }
    QString serverUrl() const { return m_url; }
    void setServerUrl(const QString &url) { m_url = url; }

signals:
    void connectedChanged();
    void panelCommandReceived(QJsonObject data);
    void rpcEventReceived(QJsonObject data);
    void error(QString message);

public slots:
    Q_INVOKABLE void connectToServer(const QString &url);
    Q_INVOKABLE void disconnect();
    Q_INVOKABLE void sendRpcCommand(const QJsonObject &cmd);
    Q_INVOKABLE void sendPanelEvent(const QJsonObject &data);

private slots:
    void onConnected();
    void onDisconnected();
    void onTextMessageReceived(const QString &message);
    void onError(QAbstractSocket::SocketError socketError);

private:
    void scheduleReconnect();

    QWebSocket m_socket;
    QString m_url;
    bool m_connected = false;
    bool m_intentionalDisconnect = false;

    QTimer m_reconnectTimer;
    int m_reconnectDelay = 2000; // ms, doubles each attempt up to maxDelay
    static constexpr int k_maxReconnectDelay = 30000;
};
