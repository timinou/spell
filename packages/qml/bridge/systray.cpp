#include "systray.h"
#include <QFile>
#include <QIcon>

SystrayManager::SystrayManager(QObject *parent) : QObject(parent) {}

SystrayManager::~SystrayManager() {
    destroy();
}

void SystrayManager::create(const QString &icon, const QString &tooltip) {
    if (!QSystemTrayIcon::isSystemTrayAvailable()) return;

    // Destroy existing before re-creating
    if (m_trayIcon) destroy();

    m_trayIcon = new QSystemTrayIcon(this);
    m_menu = new QMenu();

    if (!icon.isEmpty()) {
        // Try as file path first, then as theme icon
        if (QFile::exists(icon))
            m_trayIcon->setIcon(QIcon(icon));
        else
            m_trayIcon->setIcon(QIcon::fromTheme(icon));
    } else {
        m_trayIcon->setIcon(QIcon::fromTheme("applications-system"));
    }

    if (!tooltip.isEmpty())
        m_trayIcon->setToolTip(tooltip);

    m_trayIcon->setContextMenu(m_menu);

    connect(m_menu, &QMenu::triggered, this, &SystrayManager::onMenuTriggered);
    connect(m_trayIcon, &QSystemTrayIcon::activated, this, &SystrayManager::onTrayActivated);

    m_trayIcon->show();
    m_active = true;
}

void SystrayManager::updateMenu(const QJsonArray &items) {
    if (!m_menu) return;

    m_menu->clear();

    for (const QJsonValue &val : items) {
        const QJsonObject item = val.toObject();

        if (item["separator"].toBool()) {
            m_menu->addSeparator();
            continue;
        }

        QAction *action = m_menu->addAction(item["label"].toString());
        action->setData(item["id"].toString());
        action->setEnabled(item.contains("enabled") ? item["enabled"].toBool() : true);

        if (item.contains("checked")) {
            action->setCheckable(true);
            action->setChecked(item["checked"].toBool());
        }
    }
}

void SystrayManager::destroy() {
    if (m_trayIcon) {
        m_trayIcon->hide();
        delete m_menu;
        m_menu = nullptr;
        m_trayIcon->deleteLater();
        m_trayIcon = nullptr;
    }
    m_active = false;
}

void SystrayManager::onMenuTriggered(QAction *action) {
    emit menuItemClicked(action->data().toString());
}

void SystrayManager::onTrayActivated(QSystemTrayIcon::ActivationReason reason) {
    if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick)
        emit activated();
}
