#include "windowmanager.h"
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QQmlContext>
#include <QUrl>
#include <cstdio>

WindowManager::WindowManager(QObject *parent) : QObject(parent) {}

WindowManager::~WindowManager() {
    for (auto &entry : m_windows) {
        delete entry.engine;
    }
}

void WindowManager::setEventWriter(std::function<void(const QJsonObject&)> writer) {
    m_eventWriter = std::move(writer);
}

QJsonArray WindowManager::getWindowStates() const {
    QJsonArray arr;
    for (auto it = m_windows.constBegin(); it != m_windows.constEnd(); ++it) {
        QJsonObject obj;
        obj["id"] = it.key();
        obj["path"] = it->path;
        obj["state"] = it->state;
        arr.append(obj);
    }
    return arr;
}

void WindowManager::dispatch(const QByteArray &jsonLine) {
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(jsonLine, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
        QJsonObject errObj;
        errObj["type"] = "error";
        errObj["id"] = "";
        errObj["message"] = "Invalid JSON: " + err.errorString();
        writeEvent(errObj);
        return;
    }

    const QJsonObject msg = doc.object();
    const QString type = msg["type"].toString();
    const QString id = msg["id"].toString();

    if (type == "load") {
        const QString path = msg["path"].toString();
        const QJsonObject props = msg["props"].toObject();
        const int width = msg["width"].toInt(800);
        const int height = msg["height"].toInt(600);
        const QString title = msg["title"].toString("omp");
        loadWindow(id, path, props, width, height, title);
    } else if (type == "reload") {
        reloadWindow(id);
    } else if (type == "close") {
        closeWindow(id);
    } else if (type == "message") {
        sendMessage(id, msg["payload"].toObject());
    } else if (type == "screenshot") {
        screenshotWindow(id, msg["path"].toString());
    } else if (type == "quit") {
        QGuiApplication::quit();
    }
}

void WindowManager::loadWindow(const QString &id, const QString &path,
                               const QJsonObject &props, int width, int height,
                               const QString &title) {
    // Close existing window with same id first
    if (m_windows.contains(id)) {
        closeWindow(id);
    }

    auto *engine = new QQmlApplicationEngine(this);
    auto *bridge = new Bridge(id, engine);
    bridge->setProps(props);

    // Expose bridge to QML as context property
    engine->rootContext()->setContextProperty("bridge", bridge);
    engine->rootContext()->setContextProperty("windowTitle", title);
    engine->rootContext()->setContextProperty("windowWidth", width);
    engine->rootContext()->setContextProperty("windowHeight", height);

    // Forward bridge events to the event writer
    connect(bridge, &Bridge::eventEmitted, this, [this](const QString &wid, const QJsonObject &payload) {
        QJsonObject ev;
        ev["type"] = "event";
        ev["id"] = wid;
        ev["payload"] = payload;
        writeEvent(ev);
    });

    // Emit error if engine fails to load
    connect(engine, &QQmlApplicationEngine::objectCreationFailed, this, [this, id]() {
        if (m_windows.contains(id)) {
            m_windows[id].state = "error";
        }
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "QML object creation failed";
        writeEvent(ev);
    });

    m_windows[id] = { engine, bridge, path, "loading" };
    engine->load(QUrl::fromLocalFile(path));

    if (engine->rootObjects().isEmpty()) {
        // Load failed synchronously
        m_windows.remove(id);
        delete engine;
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Failed to load QML file: " + path;
        writeEvent(ev);
        return;
    }

    m_windows[id].state = "ready";

    QJsonObject ev;
    ev["type"] = "ready";
    ev["id"] = id;
    writeEvent(ev);
}

void WindowManager::reloadWindow(const QString &id) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(ev);
        return;
    }

    const QString path = it->path;
    const QJsonObject props = it->bridge->props();
    // Destroy the engine so a new load picks up changes
    delete it->engine;
    m_windows.remove(id);

    loadWindow(id, path, props, 800, 600, "omp");
}

void WindowManager::closeWindow(const QString &id) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) return;

    delete it->engine;
    m_windows.remove(id);

    QJsonObject ev;
    ev["type"] = "closed";
    ev["id"] = id;
    writeEvent(ev);
}

void WindowManager::sendMessage(const QString &id, const QJsonObject &payload) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(ev);
        return;
    }
    it->bridge->deliverMessage(payload);
}

void WindowManager::writeEvent(const QJsonObject &event) {
    if (m_eventWriter) {
        m_eventWriter(event);
        return;
    }
    // Default: write to stdout (backward compat for non-daemon mode)
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact) + '\n';
    fwrite(line.constData(), 1, line.size(), stdout);
    fflush(stdout);
}

void WindowManager::screenshotWindow(const QString &id, const QString &savePath) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(ev);
        return;
    }

    auto *root = qobject_cast<QQuickWindow *>(it->engine->rootObjects().first());
    if (!root) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Root object is not a QQuickWindow";
        writeEvent(ev);
        return;
    }

    const QImage image = root->grabWindow();
    if (image.isNull()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "grabWindow() returned null image";
        writeEvent(ev);
        return;
    }

    if (!image.save(savePath, "PNG")) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Failed to save screenshot to: " + savePath;
        writeEvent(ev);
        return;
    }

    QJsonObject ev;
    ev["type"] = "screenshot";
    ev["id"] = id;
    ev["path"] = savePath;
    writeEvent(ev);
}
