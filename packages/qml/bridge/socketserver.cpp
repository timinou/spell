#include <QFile>
#include "socketserver.h"
#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QStandardPaths>
#include <cstdio>
#include <cstdlib>
#include <sys/types.h>
#include <unistd.h>

SocketServer::SocketServer(QObject *parent) : QObject(parent) {
    m_server = new QLocalServer(this);
    connect(m_server, &QLocalServer::newConnection, this, &SocketServer::onNewConnection);
}

SocketServer::~SocketServer() {
    for (QLocalSocket *client : std::as_const(m_clients)) {
        client->disconnectFromServer();
    }
    if (m_server->isListening()) {
        m_server->close();
        QLocalServer::removeServer(socketPath());
    }
}

QString SocketServer::socketPath() {
    const char *xdg = std::getenv("XDG_RUNTIME_DIR");
    if (xdg && xdg[0] != '\0') {
        return QString::fromUtf8(xdg) + "/spell-qml-bridge.sock";
    }
    return QString("/tmp/spell-qml-bridge-%1.sock").arg(getuid());
}

bool SocketServer::isSocketLive(const QString &path) {
    QLocalSocket probe;
    probe.connectToServer(path);
    if (probe.waitForConnected(500)) {
        probe.disconnectFromServer();
        return true; // Another daemon is running
    }
    return false; // Stale socket
}

bool SocketServer::listen() {
    const QString path = socketPath();

    // Check for existing socket file
    if (QFile::exists(path)) {
        if (isSocketLive(path)) {
            fprintf(stderr, "Another spell-qml-bridge daemon is already running on %s\n",
                    qPrintable(path));
            return false;
        }
        // Stale socket — remove it
        QLocalServer::removeServer(path);
    }

    if (!m_server->listen(path)) {
        fprintf(stderr, "Failed to listen on %s: %s\n",
                qPrintable(path), qPrintable(m_server->errorString()));
        return false;
    }

    fprintf(stderr, "Daemon listening on %s\n", qPrintable(path));
    return true;
}

void SocketServer::writeEvent(QLocalSocket *client, const QJsonObject &event) {
    if (!client || client->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact) + '\n';
    const qint64 written = client->write(line);
    if (written < 0) {
        fprintf(stderr, "Write to client failed, disconnecting\n");
        client->disconnectFromServer();
    } else {
        client->flush();
    }
}

void SocketServer::setDispatchCallback(DispatchCallback cb) {
    m_dispatch = std::move(cb);
}

void SocketServer::setReconnectCallback(ReconnectCallback cb) {
    m_reconnect = std::move(cb);
}

void SocketServer::setDisconnectCallback(DisconnectCallback cb) {
    m_disconnect = std::move(cb);
}

void SocketServer::broadcastEvent(const QJsonObject &event) {
    for (QLocalSocket *client : std::as_const(m_clients)) {
        writeEvent(client, event);
    }
}

void SocketServer::startHeartbeat(int intervalMs) {
    if (m_heartbeatTimer) return;
    m_heartbeatTimer = new QTimer(this);
    connect(m_heartbeatTimer, &QTimer::timeout, this, [this]() {
        QJsonObject ev;
        ev["type"] = "heartbeat";
        broadcastEvent(ev);
    });
    m_heartbeatTimer->start(intervalMs);
}

void SocketServer::onNewConnection() {
    QLocalSocket *incoming = m_server->nextPendingConnection();
    if (!incoming) return;

    m_clients.append(incoming);
    m_readBuffers[incoming] = QByteArray();
    connect(incoming, &QLocalSocket::readyRead, this, &SocketServer::onClientReadyRead);
    connect(incoming, &QLocalSocket::disconnected, this, &SocketServer::onClientDisconnected);

    fprintf(stderr, "Client connected (%d total)\n", m_clients.size());

    // Notify so WindowManager can send a state snapshot for this client
    if (m_reconnect) {
        m_reconnect(incoming);
    }
}

void SocketServer::onClientReadyRead() {
    auto *client = qobject_cast<QLocalSocket *>(sender());
    if (!client) return;

    m_readBuffers[client].append(client->readAll());

    QByteArray &buf = m_readBuffers[client];
    while (true) {
        const int idx = buf.indexOf('\n');
        if (idx < 0) break;
        const QByteArray line = buf.left(idx).trimmed();
        buf.remove(0, idx + 1);
        if (!line.isEmpty() && m_dispatch) {
            m_dispatch(client, line);
        }
    }
}

void SocketServer::onClientDisconnected() {
    auto *client = qobject_cast<QLocalSocket *>(sender());
    if (!client) return;

    // Notify before cleanup so WindowManager can orphan windows while pointer is valid.
    if (m_disconnect) {
        m_disconnect(client);
    }

    m_clients.removeOne(client);
    m_readBuffers.remove(client);
    client->deleteLater();

    fprintf(stderr, "Client disconnected (%d remaining)\n", m_clients.size());
}
