#include "panelmanager.h"
#include "remoteclient.h"
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>

int main(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    app.setApplicationName("omp-remote");
    app.setOrganizationName("oh-my-pi");

    RemoteClient client;
    QQmlApplicationEngine engine;
    PanelManager panels(&engine);

    // Wire panel commands from server into PanelManager.
    QObject::connect(&client, &RemoteClient::panelCommandReceived,
                     &panels, &PanelManager::handleCommand);

    // Wire outbound panel events back to the server.
    panels.setSendEvent([&client](const QJsonObject &ev) {
        client.sendPanelEvent(ev);
    });

    engine.rootContext()->setContextProperty("remoteClient", &client);
    engine.loadFromModule("OmpRemote", "Main");

    return app.exec();
}
