#include <unistd.h>
#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonObject>
#include <QQmlContext>
#include <QSocketNotifier>
#include <cstring>
#include "socketserver.h"
#include "windowmanager.h"

static bool hasDaemonFlag(int argc, char *argv[]) {
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--daemon") == 0) return true;
    }
    return false;
}

int main(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    app.setApplicationName("omp-qml-bridge");

    WindowManager manager;

    if (hasDaemonFlag(argc, argv)) {
        // Daemon mode: communicate via Unix domain socket
        auto *server = new SocketServer(&app);
        if (!server->listen()) {
            return 1;
        }

        server->setDispatchCallback([&manager](const QByteArray &line) {
            manager.dispatch(line);
        });

        manager.setEventWriter([server](const QJsonObject &event) {
            server->writeEvent(event);
        });

        server->setReconnectCallback([server, &manager]() {
            // Send state snapshot to the newly connected client
            QJsonObject snapshot;
            snapshot["type"] = "state";
            snapshot["windows"] = manager.getWindowStates();
            server->writeEvent(snapshot);
        });
    } else {
        // Stdio mode: read JSON lines from stdin (backward compat)
        QByteArray buffer;
        auto *notifier = new QSocketNotifier(STDIN_FILENO, QSocketNotifier::Read, &app);
        QObject::connect(notifier, &QSocketNotifier::activated, [&]() {
            char chunk[4096];
            const qint64 n = read(STDIN_FILENO, chunk, sizeof(chunk));
            if (n <= 0) {
                // stdin closed — exit cleanly
                QGuiApplication::quit();
                return;
            }
            buffer.append(chunk, static_cast<int>(n));
            // Dispatch all complete newline-terminated lines
            while (true) {
                const int idx = buffer.indexOf('\n');
                if (idx < 0) break;
                const QByteArray line = buffer.left(idx).trimmed();
                buffer.remove(0, idx + 1);
                if (!line.isEmpty()) {
                    manager.dispatch(line);
                }
            }
        });
    }

    return app.exec();
}
