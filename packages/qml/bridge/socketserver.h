#pragma once
#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QLocalServer>
#include <QLocalSocket>
#include <QObject>
#include <QTimer>
#include <functional>

/**
 * Unix domain socket server for daemon mode.
 * Supports multiple concurrent clients. Each client gets its own event stream;
 * events are routed to the client that owns the target window.
 * On client disconnect, windows stay alive so the client can reconnect.
 */
class SocketServer : public QObject {
    Q_OBJECT

public:
    using DispatchCallback = std::function<void(QLocalSocket *, const QByteArray &)>;
    using ReconnectCallback = std::function<void(QLocalSocket *)>;
    using DisconnectCallback = std::function<void(QLocalSocket *)>;

    explicit SocketServer(QObject *parent = nullptr);
    ~SocketServer() override;

    /// Start listening. Returns false on fatal error (e.g. another daemon running).
    bool listen();

    /// Write a JSON event to a specific client. No-op if client is null or disconnected.
    void writeEvent(QLocalSocket *client, const QJsonObject &event);

    void setDispatchCallback(DispatchCallback cb);
    void setReconnectCallback(ReconnectCallback cb);
    void setDisconnectCallback(DisconnectCallback cb);

    /// Send a JSON event to every connected client.
    void broadcastEvent(const QJsonObject &event);

    /// Start a periodic heartbeat broadcast to all clients.
    void startHeartbeat(int intervalMs = 30000);

private slots:
    void onNewConnection();
    void onClientReadyRead();
    void onClientDisconnected();

private:
    static QString socketPath();
    /// Returns true if another daemon is already listening on the socket path.
    static bool isSocketLive(const QString &path);

    QLocalServer *m_server = nullptr;
    QList<QLocalSocket *> m_clients;
    QHash<QLocalSocket *, QByteArray> m_readBuffers;
    DispatchCallback m_dispatch;
    ReconnectCallback m_reconnect;
    DisconnectCallback m_disconnect;
    QTimer *m_heartbeatTimer = nullptr;
};
