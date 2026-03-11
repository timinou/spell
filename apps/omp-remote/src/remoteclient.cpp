#include "remoteclient.h"
#include <QJsonDocument>
#include <QJsonParseError>

RemoteClient::RemoteClient(QObject *parent) : QObject(parent) {
    m_reconnectTimer.setSingleShot(true);
    connect(&m_reconnectTimer, &QTimer::timeout, this, [this]() {
        connectToServer(m_url);
    });

    connect(&m_socket, &QWebSocket::connected, this, &RemoteClient::onConnected);
    connect(&m_socket, &QWebSocket::disconnected, this, &RemoteClient::onDisconnected);
    connect(&m_socket, &QWebSocket::textMessageReceived,
            this, &RemoteClient::onTextMessageReceived);
    connect(&m_socket, &QWebSocket::errorOccurred, this, &RemoteClient::onError);
}

void RemoteClient::connectToServer(const QString &url) {
    m_url = url;
    m_intentionalDisconnect = false;
    m_reconnectTimer.stop();
    // Close any existing connection before opening a new one
    if (m_socket.state() != QAbstractSocket::UnconnectedState) {
        m_socket.abort();
    }
    m_socket.open(QUrl(url));
}

void RemoteClient::disconnect() {
    m_intentionalDisconnect = true;
    m_reconnectTimer.stop();
    m_socket.close();
}

void RemoteClient::sendRpcCommand(const QJsonObject &cmd) {
    if (!m_connected) return;
    QJsonObject envelope;
    envelope["channel"] = "rpc";
    envelope["data"] = cmd;
    m_socket.sendTextMessage(
        QString::fromUtf8(QJsonDocument(envelope).toJson(QJsonDocument::Compact)));
}

void RemoteClient::sendPanelEvent(const QJsonObject &data) {
    if (!m_connected) return;
    QJsonObject envelope;
    envelope["channel"] = "panel";
    envelope["data"] = data;
    m_socket.sendTextMessage(
        QString::fromUtf8(QJsonDocument(envelope).toJson(QJsonDocument::Compact)));
}

void RemoteClient::onConnected() {
    m_connected = true;
    m_reconnectDelay = 2000; // reset backoff on successful connect
    emit connectedChanged();
}

void RemoteClient::onDisconnected() {
    const bool wasConnected = m_connected;
    m_connected = false;
    if (wasConnected) emit connectedChanged();

    if (!m_intentionalDisconnect) {
        scheduleReconnect();
    }
}

void RemoteClient::onTextMessageReceived(const QString &message) {
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        emit error("Invalid JSON from server: " + parseError.errorString());
        return;
    }

    const QJsonObject obj = doc.object();
    const QString channel = obj["channel"].toString();
    const QJsonObject data = obj["data"].toObject();

    if (channel == "panel") {
        emit panelCommandReceived(data);
    } else if (channel == "rpc_event") {
        emit rpcEventReceived(data);
    }
    // Unknown channels are silently dropped — server may add new ones later.
}

void RemoteClient::onError(QAbstractSocket::SocketError /*socketError*/) {
    emit error(m_socket.errorString());
}

void RemoteClient::scheduleReconnect() {
    m_reconnectTimer.start(m_reconnectDelay);
    // Exponential backoff: double the delay, cap at max
    m_reconnectDelay = std::min(m_reconnectDelay * 2, k_maxReconnectDelay);
}
