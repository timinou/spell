#include "typstdocumentitem.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QMouseEvent>
#include <QPainter>
#include <QVariant>

extern "C" {
void *typst_surface_create(bool force_degraded);
void typst_surface_dispose(void *ptr);
char *typst_surface_set_document(void *ptr, const char *source);
char *typst_surface_get_state(void *ptr);
char *typst_surface_set_viewport(void *ptr, const char *viewport_json);
char *typst_surface_hit_test(void *ptr, float x, float y);
char *typst_surface_snapshot_svg(void *ptr);
char *typst_surface_last_error(void *ptr);
void typst_surface_free_string(char *ptr);
}

TypstDocumentItem::TypstDocumentItem(QQuickItem *parent)
    : QQuickPaintedItem(parent) {
    setAcceptedMouseButtons(Qt::LeftButton);
    setAntialiasing(true);
}

TypstDocumentItem::~TypstDocumentItem() {
    disposeSession();
}

QString TypstDocumentItem::source() const {
    return m_source;
}

void TypstDocumentItem::setSource(const QString &source) {
    if (m_source == source) return;
    m_source = source;
    emit sourceChanged();
    syncDocument();
}

bool TypstDocumentItem::forceDegraded() const {
    return m_forceDegraded;
}

void TypstDocumentItem::setForceDegraded(bool forceDegraded) {
    if (m_forceDegraded == forceDegraded) return;
    m_forceDegraded = forceDegraded;
    emit forceDegradedChanged();
    recreateSession();
}

bool TypstDocumentItem::ready() const {
    return m_ready;
}

bool TypstDocumentItem::degraded() const {
    return m_degraded;
}

QString TypstDocumentItem::capability() const {
    return m_capability;
}

QString TypstDocumentItem::capabilityReason() const {
    return m_capabilityReason;
}

QString TypstDocumentItem::statusMessage() const {
    return m_statusMessage;
}

QString TypstDocumentItem::lastError() const {
    return m_lastError;
}

QString TypstDocumentItem::svgSnapshot() const {
    return m_svgSnapshot;
}

qreal TypstDocumentItem::zoom() const {
    return m_zoom;
}

void TypstDocumentItem::setZoom(qreal zoom) {
    const qreal nextZoom = std::max<qreal>(0.25, zoom);
    if (qFuzzyCompare(m_zoom, nextZoom)) return;
    m_zoom = nextZoom;
    emit viewportChanged();
    syncViewport();
}

qreal TypstDocumentItem::scrollX() const {
    return m_scrollX;
}

void TypstDocumentItem::setScrollX(qreal scrollX) {
    const qreal nextScrollX = std::max<qreal>(0.0, scrollX);
    if (qFuzzyCompare(m_scrollX, nextScrollX)) return;
    m_scrollX = nextScrollX;
    emit viewportChanged();
    syncViewport();
}

qreal TypstDocumentItem::scrollY() const {
    return m_scrollY;
}

void TypstDocumentItem::setScrollY(qreal scrollY) {
    const qreal nextScrollY = std::max<qreal>(0.0, scrollY);
    if (qFuzzyCompare(m_scrollY, nextScrollY)) return;
    m_scrollY = nextScrollY;
    emit viewportChanged();
    syncViewport();
}

QVariantMap TypstDocumentItem::hitTest(qreal x, qreal y) {
    ensureSession();
    if (m_session == nullptr) {
        return QVariantMap{{"kind", "error"}, {"message", "Session unavailable"}};
    }
    const QString json = takeString(typst_surface_hit_test(m_session, static_cast<float>(x), static_cast<float>(y)));
    return parseJsonObject(json);
}

QString TypstDocumentItem::snapshotSvg() const {
    return m_svgSnapshot;
}

QVariantMap TypstDocumentItem::stateSnapshot() const {
    return m_stateSnapshot;
}

void TypstDocumentItem::paint(QPainter *painter) {
    painter->save();
    painter->fillRect(boundingRect(), QColor("#f5f4ef"));
    if (!m_svgSnapshot.isEmpty() && m_renderer.isValid()) {
        m_renderer.render(painter, boundingRect());
    } else {
        painter->setPen(QColor("#6b7280"));
        painter->drawText(boundingRect().adjusted(24, 24, -24, -24), Qt::AlignCenter,
                          m_statusMessage.isEmpty() ? QStringLiteral("No Typst document loaded") : m_statusMessage);
    }
    painter->restore();
}

void TypstDocumentItem::geometryChange(const QRectF &newGeometry, const QRectF &oldGeometry) {
    QQuickPaintedItem::geometryChange(newGeometry, oldGeometry);
    if (newGeometry.size() == oldGeometry.size()) return;
    syncViewport();
}

void TypstDocumentItem::mousePressEvent(QMouseEvent *event) {
    const QVariantMap hit = hitTest(event->position().x(), event->position().y());
    emit hitResolved(hit);
    event->accept();
}

void TypstDocumentItem::ensureSession() {
    if (m_session != nullptr) return;
    m_session = typst_surface_create(m_forceDegraded);
    syncViewport();
    if (!m_source.isEmpty()) {
        syncDocument();
        return;
    }
    const QString stateJson = takeString(typst_surface_get_state(m_session));
    applyStateJson(stateJson);
    refreshSvgSnapshot();
}

void TypstDocumentItem::disposeSession() {
    if (m_session == nullptr) return;
    typst_surface_dispose(m_session);
    m_session = nullptr;
}

void TypstDocumentItem::recreateSession() {
    disposeSession();
    ensureSession();
}

void TypstDocumentItem::syncDocument() {
    ensureSession();
    if (m_session == nullptr) return;
    const QByteArray utf8 = m_source.toUtf8();
    const QString stateJson = takeString(typst_surface_set_document(m_session, utf8.constData()));
    applyStateJson(stateJson);
    refreshSvgSnapshot();
}

void TypstDocumentItem::syncViewport() {
    ensureSession();
    if (m_session == nullptr) return;
    const QJsonObject viewport{
        {"width", width()},
        {"height", height()},
        {"zoom", m_zoom},
        {"scrollX", m_scrollX},
        {"scrollY", m_scrollY},
    };
    const QByteArray json = QJsonDocument(viewport).toJson(QJsonDocument::Compact);
    const QString stateJson = takeString(typst_surface_set_viewport(m_session, json.constData()));
    applyStateJson(stateJson);
    refreshSvgSnapshot();
}

void TypstDocumentItem::applyStateJson(const QString &json) {
    const QVariantMap object = parseJsonObject(json);
    m_stateSnapshot = object;
    m_ready = object.value("ready").toBool();
    m_degraded = object.value("degraded").toBool();
    m_capability = object.value("capability").toString();
    m_capabilityReason = object.value("capabilityReason").toString();
    m_statusMessage = object.value("statusMessage").toString();
    m_lastError = object.value("lastError").toString();
    emit stateChanged();
}

void TypstDocumentItem::refreshSvgSnapshot() {
    if (m_session == nullptr) return;
    m_svgSnapshot = takeString(typst_surface_snapshot_svg(m_session));
    if (!m_svgSnapshot.isEmpty()) {
        m_renderer.load(m_svgSnapshot.toUtf8());
    }
    const QString ffiError = takeString(typst_surface_last_error(m_session));
    if (!ffiError.isEmpty()) {
        m_lastError = ffiError;
    }
    update();
    emit stateChanged();
}

QVariantMap TypstDocumentItem::parseJsonObject(const QString &json) const {
    if (json.isEmpty()) return {};
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(json.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) {
        return QVariantMap{{"kind", "error"},
                           {"message", QStringLiteral("Failed to parse Typst surface payload: ") + error.errorString()},
                           {"raw", json}};
    }
    return document.object().toVariantMap();
}

QString TypstDocumentItem::takeString(char *ptr) const {
    if (ptr == nullptr) return {};
    const QString value = QString::fromUtf8(ptr);
    typst_surface_free_string(ptr);
    return value;
}
