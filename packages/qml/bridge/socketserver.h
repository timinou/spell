#pragma once
#include <QHash>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QObject>
#include <functional>

/**
 * Unix domain socket server for daemon mode.
 * Accepts a single client at a time. On disconnect, windows stay alive
 * and the server waits for a new client to reconnect.
 */
class SocketServer : public QObject {
    Q_OBJECT

public:
    using DispatchCallback = std::function<void(const QByteArray &)>;
    using ReconnectCallback = std::function<void()>;

    explicit SocketServer(QObject *parent = nullptr);
    ~SocketServer() override;

    /// Start listening. Returns false on fatal error (e.g. another daemon running).
    bool listen();

    /// Write a JSON event to the connected client. No-op if no client.
    void writeEvent(const QJsonObject &event);

    void setDispatchCallback(DispatchCallback cb);
    void setReconnectCallback(ReconnectCallback cb);

private slots:
    void onNewConnection();
    void onClientReadyRead();
    void onClientDisconnected();

private:
    static QString socketPath();
    /// Returns true if another daemon is already listening on the socket path.
    static bool isSocketLive(const QString &path);

    QLocalServer *m_server = nullptr;
    QLocalSocket *m_client = nullptr;
    QByteArray m_readBuffer;
    DispatchCallback m_dispatch;
    ReconnectCallback m_reconnect;
};
