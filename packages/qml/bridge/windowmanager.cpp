#include "windowmanager.h"
#include <QGuiApplication>
#include <QImage>
#include <QJsonDocument>
#include <QQmlContext>
#include <QUrl>
#include <QJSValue>
#include <cstdio>
#include <QQuickItem>
#include <QPointF>

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
        if (!it->armedTools.isEmpty()) {
            QJsonArray toolsArr;
            for (const auto &t : it->armedTools) toolsArr.append(t);
            obj["armedTools"] = toolsArr;
        }
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
    } else if (type == "query") {
        queryItems(id, msg);
    } else if (type == "eval") {
        evalInWindow(id, msg["expression"].toString());
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

    QJsonObject ev;
    ev["type"] = "ready";
    ev["id"] = id;
    if (!armedToolsList.isEmpty()) {
        QJsonArray toolsArr;
        for (const auto &t : armedToolsList) toolsArr.append(t);
        ev["armedTools"] = toolsArr;
    }
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

void WindowManager::queryItems(const QString &id, const QJsonObject &msg) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(ev);
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
        writeEvent(ev);
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
    writeEvent(ev);
}

void WindowManager::evalInWindow(const QString &id, const QString &expression) {
    const auto it = m_windows.constFind(id);
    if (it == m_windows.constEnd()) {
        QJsonObject ev;
        ev["type"] = "error";
        ev["id"] = id;
        ev["message"] = "Window not found: " + id;
        writeEvent(ev);
        return;
    }

    QJSEngine *jsEngine = it->engine; // QQmlApplicationEngine IS-A QJSEngine
    QObject *root = it->engine->rootObjects().first();
    QJSValue rootVal = jsEngine->newQObject(root);
    QJSValue globalObj = jsEngine->globalObject();
    globalObj.setProperty("root", rootVal);

    QJSValue result = jsEngine->evaluate(expression);
    // Clean up injected global
    globalObj.deleteProperty("root");

    QJsonObject ev;
    ev["type"] = "eval_result";
    ev["id"] = id;
    if (result.isError()) {
        ev["error"] = result.toString();
        ev["value"] = QJsonValue::Null;
    } else {
        ev["error"] = QJsonValue::Null;
        ev["value"] = QJsonValue::fromVariant(result.toVariant());
    }
    writeEvent(ev);
}