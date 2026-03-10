#include "bridge.h"

Bridge::Bridge(const QString &windowId, QObject *parent)
    : QObject(parent), m_windowId(windowId) {}

void Bridge::setProps(const QJsonObject &props) {
    m_props = props;
    emit propsChanged();
}

void Bridge::deliverMessage(const QJsonObject &payload) {
    emit messageReceived(payload);
}

void Bridge::send(const QJsonObject &payload) {
    emit eventEmitted(m_windowId, payload);
}
