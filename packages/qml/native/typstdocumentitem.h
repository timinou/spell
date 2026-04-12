class QMouseEvent;
class QPainter;

#pragma once

#include <QQuickPaintedItem>
#include <QSvgRenderer>
#include <QVariantMap>

class TypstDocumentItem : public QQuickPaintedItem {
    Q_OBJECT
    Q_PROPERTY(QString source READ source WRITE setSource NOTIFY sourceChanged)
    Q_PROPERTY(bool forceDegraded READ forceDegraded WRITE setForceDegraded NOTIFY forceDegradedChanged)
    Q_PROPERTY(bool ready READ ready NOTIFY stateChanged)
    Q_PROPERTY(bool degraded READ degraded NOTIFY stateChanged)
    Q_PROPERTY(QString capability READ capability NOTIFY stateChanged)
    Q_PROPERTY(QString capabilityReason READ capabilityReason NOTIFY stateChanged)
    Q_PROPERTY(QString statusMessage READ statusMessage NOTIFY stateChanged)
    Q_PROPERTY(QString lastError READ lastError NOTIFY stateChanged)
    Q_PROPERTY(QString svgSnapshot READ svgSnapshot NOTIFY stateChanged)
    Q_PROPERTY(qreal zoom READ zoom WRITE setZoom NOTIFY viewportChanged)
    Q_PROPERTY(qreal scrollX READ scrollX WRITE setScrollX NOTIFY viewportChanged)
    Q_PROPERTY(qreal scrollY READ scrollY WRITE setScrollY NOTIFY viewportChanged)

public:
    explicit TypstDocumentItem(QQuickItem *parent = nullptr);
    ~TypstDocumentItem() override;

    QString source() const;
    void setSource(const QString &source);

    bool forceDegraded() const;
    void setForceDegraded(bool forceDegraded);

    bool ready() const;
    bool degraded() const;
    QString capability() const;
    QString capabilityReason() const;
    QString statusMessage() const;
    QString lastError() const;
    QString svgSnapshot() const;

    qreal zoom() const;
    void setZoom(qreal zoom);

    qreal scrollX() const;
    void setScrollX(qreal scrollX);

    qreal scrollY() const;
    void setScrollY(qreal scrollY);

    Q_INVOKABLE QVariantMap hitTest(qreal x, qreal y);
    Q_INVOKABLE QString snapshotSvg() const;
    Q_INVOKABLE QVariantMap stateSnapshot() const;

    void paint(QPainter *painter) override;

signals:
    void sourceChanged();
    void forceDegradedChanged();
    void viewportChanged();
    void stateChanged();
    void hitResolved(const QVariantMap &hit);

protected:
    void geometryChange(const QRectF &newGeometry, const QRectF &oldGeometry) override;
    void mousePressEvent(QMouseEvent *event) override;

private:
    void ensureSession();
    void disposeSession();
    void recreateSession();
    void syncDocument();
    void syncViewport();
    void applyStateJson(const QString &json);
    void refreshSvgSnapshot();
    QVariantMap parseJsonObject(const QString &json) const;

    QString takeString(char *ptr) const;

    QString m_source;
    bool m_forceDegraded = false;
    bool m_ready = false;
    bool m_degraded = false;
    QString m_capability;
    QString m_capabilityReason;
    QString m_statusMessage;
    QString m_lastError;
    QString m_svgSnapshot;
    QVariantMap m_stateSnapshot;
    qreal m_zoom = 1.0;
    qreal m_scrollX = 0.0;
    qreal m_scrollY = 0.0;
    void *m_session = nullptr;
    QSvgRenderer m_renderer;
};
