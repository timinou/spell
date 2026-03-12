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
    // Accept only one connection at a time
    m_server->setMaxPendingConnections(1);
    connect(m_server, &QLocalServer::newConnection, this, &SocketServer::onNewConnection);
}

SocketServer::~SocketServer() {
    if (m_client) {
        m_client->disconnectFromServer();
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

void SocketServer::writeEvent(const QJsonObject &event) {
    if (!m_client || m_client->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact) + '\n';
    const qint64 written = m_client->write(line);
    if (written < 0) {
        // Write failed — client is gone
        fprintf(stderr, "Write to client failed, disconnecting\n");
        m_client->disconnectFromServer();
    } else {
        m_client->flush();
    }
}

void SocketServer::setDispatchCallback(DispatchCallback cb) {
    m_dispatch = std::move(cb);
}

void SocketServer::setReconnectCallback(ReconnectCallback cb) {
    m_reconnect = std::move(cb);
}

void SocketServer::onNewConnection() {
    QLocalSocket *incoming = m_server->nextPendingConnection();
    if (!incoming) return;

    // If there's an existing client, disconnect it
    if (m_client) {
        m_client->disconnectFromServer();
        m_client->deleteLater();
        m_client = nullptr;
        m_readBuffer.clear();
    }

    m_client = incoming;
    connect(m_client, &QLocalSocket::readyRead, this, &SocketServer::onClientReadyRead);
    connect(m_client, &QLocalSocket::disconnected, this, &SocketServer::onClientDisconnected);

    fprintf(stderr, "Client connected\n");

    // Notify so WindowManager can send a state snapshot
    if (m_reconnect) {
        m_reconnect();
    }
}

void SocketServer::onClientReadyRead() {
    if (!m_client) return;

    m_readBuffer.append(m_client->readAll());

    while (true) {
        const int idx = m_readBuffer.indexOf('\n');
        if (idx < 0) break;
        const QByteArray line = m_readBuffer.left(idx).trimmed();
        m_readBuffer.remove(0, idx + 1);
        if (!line.isEmpty() && m_dispatch) {
            m_dispatch(line);
        }
    }
}

void SocketServer::onClientDisconnected() {
    fprintf(stderr, "Client disconnected, waiting for reconnection\n");
    if (m_client) {
        m_client->deleteLater();
        m_client = nullptr;
    }
    m_readBuffer.clear();
    // Server keeps running — windows stay alive
}
