#include "windowmanager.h"
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QQmlContext>
#include <QUrl>
#include <QJSValue>
#include <QQmlExpression>
#include <cstdio>
#include <QQuickItem>
#include <QPointF>

WindowManager::WindowManager(QObject *parent) : QObject(parent) {}

WindowManager::~WindowManager() {
    for (auto &entry : m_windows) {
        delete entry.engine;
    }
}

void WindowManager::setEventWriter(std::function<void(QLocalSocket *, const QJsonObject &)> writer) {
    m_eventWriter = std::move(writer);
}

QJsonArray WindowManager::getWindowStates(QLocalSocket *client) const {
    QJsonArray arr;
    for (auto it = m_windows.constBegin(); it != m_windows.constEnd(); ++it) {
        // In daemon mode, only return windows belonging to this client.
        // In stdio mode (client == nullptr), return all windows.
        if (client != nullptr && it->owner != client) continue;

        QJsonObject obj;
        obj["id"] = it.key();
        obj["path"] = it->path;
        obj["state"] = it->state;
        if (!it->armedTools.isEmpty()) {
            QJsonArray toolsArr;
            for (const auto &t : it->armedTools) toolsArr.append(t);
            obj["armedTools"] = toolsArr;
        }
        arr.append(obj);
    }
    return arr;
}

void WindowManager::dispatch(QLocalSocket *client, const QByteArray &jsonLine) {
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(jsonLine, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
        QJsonObject errObj;
        errObj["type"] = "error";
        errObj["id"] = "";
        errObj["message"] = "Invalid JSON: " + err.errorString();
        writeEvent(client, errObj);
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
        loadWindow(client, id, path, props, width, height, title);
    } else if (type == "reload") {
        reloadWindow(client, id);
    } else if (type == "close") {
        closeWindow(client, id);
    } else if (type == "message") {
        sendMessage(client, id, msg["payload"].toObject());
    } else if (type == "screenshot") {
        screenshotWindow(client, id, msg["path"].toString());
    } else if (type == "query") {
        queryItems(client, id, msg);
    } else if (type == "eval") {
        evalInWindow(client, id, msg["expression"].toString());
    } else if (type == "quit") {
        // Close only windows owned by this client, then quit if none remain.
        QStringList ownedIds;
        for (auto it = m_windows.constBegin(); it != m_windows.constEnd(); ++it) {
            if (it->owner == client) ownedIds.append(it.key());
        }
        for (const QString &wid : std::as_const(ownedIds)) {
            closeWindow(client, wid);
        }
        if (m_windows.isEmpty()) {
            QGuiApplication::quit();
        }
    }
}

void WindowManager::loadWindow(QLocalSocket *client, const QString &id, const QString &path,
                               const QJsonObject &props, int width, int height,
                               const QString &title) {
    // Close existing window with same id first
    if (m_windows.contains(id)) {
        closeWindow(client, id);
    }

    auto *engine = new QQmlApplicationEngine(this);
    auto *bridge = new Bridge(id, engine);
    bridge->setProps(props);

    // Expose bridge to QML as context property
    engine->rootContext()->setContextProperty("bridge", bridge);
    engine->rootContext()->setContextProperty("windowTitle", title);
    engine->rootContext()->setContextProperty("windowWidth", width);
    engine->rootContext()->setContextProperty("windowHeight", height);

    // Forward bridge events to the owning client
    connect(bridge, &Bridge::eventEmitted, this, [this](const QString &wid, const QJsonObject &payload) {
        QJsonObject ev;
        ev["type"] = "event";
        ev["id"] = wid;
        ev["payload"] = payload;
        writeEventToOwner(wid, ev);
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
        writeEventToOwner(id, ev);
    });

    m_windows[id] = { engine, bridge, path, "loading", {}, client };
    engine->load(QUrl::fromLocalFile(path));

    if (engine->rootObjects().isEmpty()) {
        // Load failed synchronously
        m_windows.remove(id);
        delete engine;
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Failed to load QML file: " + path;
        writeEvent(client, ev);
        return;
    }

    m_windows[id].state = "ready";

    // Read declarative armed tools from root QML property
    QStringList armedToolsList;
    QObject *root = engine->rootObjects().first();
    QJSValue jsVal = root->property("spellArmedTools").value<QJSValue>();
    if (jsVal.isArray()) {
        int len = jsVal.property("length").toInt();
        for (int i = 0; i < len; ++i) {
            QString s = jsVal.property(i).toString();
            if (!s.isEmpty()) armedToolsList.append(s);
        }
    }
    m_windows[id].armedTools = armedToolsList;

    // Detect user/WM-initiated window close
    auto *rootWin = qobject_cast<QQuickWindow *>(engine->rootObjects().first());
    if (rootWin) {
        connect(rootWin, &QQuickWindow::closing, this, [this, id](QQuickCloseEvent *) {
            // Guard against double-close (e.g. TS side already sent close command)
            if (!m_windows.contains(id)) return;
            QLocalSocket *owner = m_windows[id].owner; // capture before removal
            delete m_windows[id].engine;
            m_windows.remove(id);
            QJsonObject ev;
            ev["type"] = "closed";
            ev["id"] = id;
            ev["wmClose"] = true;
            writeEvent(owner, ev);
        });
    }

    QJsonObject ev;
    ev["type"] = "ready";
    ev["id"] = id;
    if (!armedToolsList.isEmpty()) {
        QJsonArray toolsArr;
        for (const auto &t : armedToolsList) toolsArr.append(t);
        ev["armedTools"] = toolsArr;
    }
    writeEventToOwner(id, ev);
}

void WindowManager::reloadWindow(QLocalSocket *client, const QString &id) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(client, ev);
        return;
    }

    const QString path = it->path;
    const QJsonObject props = it->bridge->props();
    // Destroy the engine so a new load picks up changes
    delete it->engine;
    m_windows.remove(id);

    loadWindow(client, id, path, props, 800, 600, "omp");
}

void WindowManager::closeWindow(QLocalSocket *client, const QString &id) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) return;

    QLocalSocket *owner = it->owner;
    QQmlApplicationEngine *engine = it->engine;
    m_windows.remove(id);

    QJsonObject ev;
    ev["type"] = "closed";
    ev["id"] = id;
    // Route closed event to owner; fall back to requesting client if no owner recorded
    writeEvent(owner ? owner : client, ev);

    engine->deleteLater();  // deferred cleanup
}

void WindowManager::sendMessage(QLocalSocket *client, const QString &id, const QJsonObject &payload) {
    auto it = m_windows.find(id);
    if (it == m_windows.end()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(client, ev);
        return;
    }
    it->bridge->deliverMessage(payload);
}

void WindowManager::writeEvent(QLocalSocket *client, const QJsonObject &event) {
    if (m_eventWriter) {
        m_eventWriter(client, event);
        return;
    }
    // Default: write to stdout (backward compat for non-daemon mode)
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact) + '\n';
    fwrite(line.constData(), 1, line.size(), stdout);
    fflush(stdout);
}

void WindowManager::writeEventToOwner(const QString &windowId, const QJsonObject &event) {
    auto it = m_windows.constFind(windowId);
    if (it == m_windows.constEnd()) return;
    writeEvent(it->owner, event);
}

void WindowManager::screenshotWindow(QLocalSocket *client, const QString &id, const QString &savePath) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(client, ev);
        return;
    }

    auto *root = qobject_cast<QQuickWindow *>(it->engine->rootObjects().first());
    if (!root) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Root object is not a QQuickWindow";
        writeEventToOwner(id, ev);
        return;
    }

    const QImage image = root->grabWindow();
    if (image.isNull()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "grabWindow() returned null image";
        writeEventToOwner(id, ev);
        return;
    }

    if (!image.save(savePath, "PNG")) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Failed to save screenshot to: " + savePath;
        writeEventToOwner(id, ev);
        return;
    }

    QJsonObject ev;
    ev["type"] = "screenshot";
    ev["id"] = id;
    ev["path"] = savePath;
    writeEventToOwner(id, ev);
}


WindowManager::QuerySelector WindowManager::parseSelector(const QJsonObject &sel) {
    QuerySelector s;
    s.type = sel["type"].toString();
    s.objectName = sel["objectName"].toString();
    if (!sel["visible"].isUndefined() && !sel["visible"].isNull())
        s.visible = sel["visible"].toBool();
    s.textContains = sel["textContains"].toString();
    return s;
}

bool WindowManager::matchesSelector(const QQuickItem *item, const QuerySelector &sel) {
    if (!sel.type.isEmpty()) {
        if (!QString(item->metaObject()->className()).startsWith(sel.type))
            return false;
    }
    if (!sel.objectName.isEmpty()) {
        if (item->objectName() != sel.objectName)
            return false;
    }
    if (sel.visible.has_value()) {
        if (item->isVisible() != *sel.visible)
            return false;
    }
    if (!sel.textContains.isEmpty()) {
        const QVariant textProp = item->property("text");
        if (!textProp.isValid() || !textProp.toString().contains(sel.textContains))
            return false;
    }
    return true;
}

QJsonValue WindowManager::readProperty(const QObject *obj, const QString &name) {
    const int dot = name.indexOf('.');
    if (dot == -1) {
        const QVariant v = obj->property(name.toLatin1().constData());
        if (!v.isValid()) return QJsonValue::Undefined;
        if (v.canConvert<QObject *>()) return QJsonValue(QString("[object]"));
        return QJsonValue::fromVariant(v);
    }
    // Dotted path: recurse into sub-object
    const QString first = name.left(dot);
    const QString rest = name.mid(dot + 1);
    const QVariant sub = obj->property(first.toLatin1().constData());
    if (!sub.isValid()) return QJsonValue::Undefined;
    QObject *subObj = sub.value<QObject *>();
    if (!subObj) return QJsonValue::Undefined;
    return readProperty(subObj, rest);
}

QJsonObject WindowManager::serializeItem(const QQuickItem *item, const QJsonArray &props,
                                         bool includeGeometry, const QString &path) {
    QJsonObject obj;
    obj["className"] = QString(item->metaObject()->className());
    obj["objectName"] = item->objectName();
    obj["visible"] = item->isVisible();
    obj["opacity"] = item->opacity();
    obj["enabled"] = item->isEnabled();
    obj["clip"] = item->clip();
    obj["childCount"] = static_cast<int>(item->childItems().size());
    obj["path"] = path;

    if (includeGeometry) {
        QJsonObject geom;
        geom["x"] = item->x();
        geom["y"] = item->y();
        geom["width"] = item->width();
        geom["height"] = item->height();
        obj["geometry"] = geom;

        const QPointF scene = item->mapToScene(QPointF(0, 0));
        QJsonObject sp;
        sp["x"] = scene.x();
        sp["y"] = scene.y();
        obj["scenePosition"] = sp;
    }

    QJsonObject propsObj;
    for (const auto &p : props) {
        const QString propName = p.toString();
        propsObj[propName] = readProperty(item, propName);
    }
    obj["properties"] = propsObj;

    return obj;
}

void WindowManager::walkTree(const QQuickItem *item, const QuerySelector &sel,
                             const QJsonArray &props, bool includeGeometry,
                             int maxDepth, int depth, const QString &path,
                             QJsonArray &results) {
    if (depth > maxDepth) return;

    if (matchesSelector(item, sel)) {
        results.append(serializeItem(item, props, includeGeometry, path));
    }

    const auto children = item->childItems();
    // Count siblings per class for index disambiguation
    QHash<QString, int> seen;
    for (const auto *child : children) {
        const QString cls = QString(child->metaObject()->className());
        const int idx = seen.value(cls, 0);
        seen[cls] = idx + 1;
        QString childPath = path + "/" + cls;
        if (idx > 0) childPath += "[" + QString::number(idx) + "]";
        walkTree(child, sel, props, includeGeometry, maxDepth, depth + 1, childPath, results);
    }
}

void WindowManager::queryItems(QLocalSocket *client, const QString &id, const QJsonObject &msg) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(client, ev);
        return;
    }

    QObject *rootObj = it->engine->rootObjects().first();
    auto *rootItem = qobject_cast<QQuickItem *>(rootObj);
    if (!rootItem) {
        // ApplicationWindow root is a QQuickWindow; get its visual content item
        auto *rootWin = qobject_cast<QQuickWindow *>(rootObj);
        if (rootWin) rootItem = rootWin->contentItem();
    }
    if (!rootItem) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Root object is not a QQuickItem";
        writeEventToOwner(id, ev);
        return;
    }

    const QuerySelector sel = parseSelector(msg["selector"].toObject());
    const QJsonArray props = msg["properties"].toArray();
    const bool includeGeometry = msg["includeGeometry"].toBool(false);
    const int maxDepth = msg["maxDepth"].toInt(20);

    QJsonArray items;
    const QString rootPath = QString(rootItem->metaObject()->className());
    walkTree(rootItem, sel, props, includeGeometry, maxDepth, 0, rootPath, items);

    QJsonObject ev;
    ev["type"] = "query_result";
    ev["id"] = id;
    ev["items"] = items;
    writeEventToOwner(id, ev);
}

void WindowManager::evalInWindow(QLocalSocket *client, const QString &id, const QString &expression) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(client, ev);
        return;
    }

    QObject *root = it->engine->rootObjects().first();
    // Use the object's creation context so QML component-local ids (e.g. "canvas")
    // and context properties (e.g. "bridge") are both resolvable.
    QQmlContext *ctx = QQmlEngine::contextForObject(root);
    if (!ctx) ctx = it->engine->rootContext();
    QQmlExpression expr(ctx, root, expression);
    bool valueIsUndefined = false;
    QVariant resultVariant = expr.evaluate(&valueIsUndefined);

    QJsonObject ev;
    ev["type"] = "eval_result";
    ev["id"] = id;
    if (expr.hasError()) {
        ev["error"] = expr.error().toString();
        ev["value"] = QJsonValue::Null;
    } else {
        ev["error"] = QJsonValue::Null;
        ev["value"] = QJsonValue::fromVariant(resultVariant);
    }
    writeEventToOwner(id, ev);
}
