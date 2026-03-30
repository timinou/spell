#pragma once
#include <QAction>
#include <QJsonArray>
#include <QJsonObject>
#include <QMenu>
#include <QObject>
#include <QSystemTrayIcon>

class SystrayManager : public QObject {
    Q_OBJECT

public:
    explicit SystrayManager(QObject *parent = nullptr);
    ~SystrayManager() override;

    void create(const QString &icon, const QString &tooltip);
    void updateMenu(const QJsonArray &items);
    void destroy();

signals:
    void menuItemClicked(const QString &itemId);
    void activated();

private slots:
    void onMenuTriggered(QAction *action);
    void onTrayActivated(QSystemTrayIcon::ActivationReason reason);

private:
    QSystemTrayIcon *m_trayIcon = nullptr;
    QMenu *m_menu = nullptr;
    bool m_active = false;
};
