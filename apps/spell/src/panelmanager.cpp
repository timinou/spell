#include "panelmanager.h"
#include <QDir>
#include <QFile>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQmlEngine>
#include <QStandardPaths>
#include <QUrl>

PanelManager::PanelManager(QQmlEngine *hostEngine, QObject *parent)
    : QObject(parent), m_hostEngine(hostEngine) {
    // Panels write QML into app-local storage, the only writable dir on Android.
    const QString base =
        QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    m_panelCacheDir = base + "/panels";
    QDir().mkpath(m_panelCacheDir);
}

PanelManager::~PanelManager() {
    for (auto &entry : m_panels) {
        delete entry.engine; // Bridge is parented to engine, deleted with it
    }
}

void PanelManager::setSendEvent(std::function<void(const QJsonObject &)> fn) {
    m_sendEvent = std::move(fn);
}

void PanelManager::handleCommand(const QJsonObject &data) {
    const QString type = data["type"].toString();
    const QString id = data["id"].toString();

    if (type == "push_qml") {
        pushQml(id,
                data["content"].toString(),
                data["props"].toObject(),
                data["title"].toString("panel"),
                data["width"].toInt(800),
                data["height"].toInt(600));
    } else if (type == "message") {
        auto it = m_panels.find(id);
        if (it != m_panels.end()) {
            it->bridge->deliverMessage(data["payload"].toObject());
        }
    } else if (type == "close_panel") {
        closePanel(id, /*sendUpstream=*/true);
    } else if (type == "reload_panel") {
        auto it = m_panels.find(id);
        if (it == m_panels.end()) {
            sendEvent(QJsonObject{
                {"type", "panel_error"},
                {"id", id},
                {"message", "reload_panel: panel not found"}});
            return;
        }
        // Re-read saved content, destroy existing engine, reload fresh.
        const QString path = it->qmlPath;
        const QJsonObject props = it->bridge->props();
        closePanel(id, /*sendUpstream=*/false);

        QFile f(path);
        if (!f.open(QIODevice::ReadOnly)) {
            sendEvent(QJsonObject{
                {"type", "panel_error"},
                {"id", id},
                {"message", "reload_panel: cannot read cached QML"}});
            return;
        }
        const QString content = QString::fromUtf8(f.readAll());
        pushQml(id, content, props, "panel", 800, 600);
    }
    // Unknown command types are silently ignored — forward-compatibility.
}

void PanelManager::pushQml(const QString &id, const QString &content,
                           const QJsonObject &props, const QString &title,
                           int width, int height) {
    // Replace any existing panel with this id.
    if (m_panels.contains(id)) {
        closePanel(id, /*sendUpstream=*/false);
    }

    // Write QML content to app-local storage.
    const QString path = m_panelCacheDir + "/" + id + ".qml";
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        emit panelError(id, "Cannot write panel QML to " + path);
        sendEvent(QJsonObject{
            {"type", "panel_error"},
            {"id", id},
            {"message", "Cannot write QML: " + path}});
        return;
    }
    f.write(content.toUtf8());
    f.close();

    auto *engine = new QQmlApplicationEngine(this);
    auto *bridge = new Bridge(id, engine); // parented to engine
    bridge->setProps(props);

    // Inject the same context properties the desktop WindowManager injects.
    engine->rootContext()->setContextProperty("bridge", bridge);
    engine->rootContext()->setContextProperty("windowTitle", title);
    engine->rootContext()->setContextProperty("windowWidth", width);
    engine->rootContext()->setContextProperty("windowHeight", height);

    // Forward bridge events upstream as panel_event messages.
    connect(bridge, &Bridge::eventEmitted,
            this, [this, id](const QString & /*wid*/, const QJsonObject &payload) {
                sendEvent(QJsonObject{
                    {"type", "panel_event"},
                    {"id", id},
                    {"name", payload["name"].toString()},
                    {"payload", payload}});
            });

    // Report load failure.
    connect(engine, &QQmlApplicationEngine::objectCreationFailed, this, [this, id]() {
        emit panelError(id, "QML object creation failed");
        sendEvent(QJsonObject{
            {"type", "panel_error"},
            {"id", id},
            {"message", "QML object creation failed"}});
    });

    m_panels[id] = PanelEntry{engine, bridge, id, path};
    engine->load(QUrl::fromLocalFile(path));

    if (engine->rootObjects().isEmpty()) {
        // Synchronous load failure.
        m_panels.remove(id);
        delete engine;
        const QString msg = "Failed to load QML file: " + path;
        emit panelError(id, msg);
        sendEvent(QJsonObject{
            {"type", "panel_error"},
            {"id", id},
            {"message", msg}});
        return;
    }

    emit panelLoaded(id);
    sendEvent(QJsonObject{{"type", "panel_ready"}, {"id", id}});
}

void PanelManager::closePanel(const QString &id, bool sendUpstream) {
    auto it = m_panels.find(id);
    if (it == m_panels.end()) return;

    delete it->engine; // also deletes bridge
    m_panels.erase(it);

    emit panelClosed(id);
    if (sendUpstream) {
        sendEvent(QJsonObject{{"type", "panel_closed"}, {"id", id}});
    }
}

void PanelManager::sendEvent(const QJsonObject &data) {
    if (m_sendEvent) {
        m_sendEvent(data);
    }
}
