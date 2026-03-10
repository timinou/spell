#include <unistd.h>
#include <QGuiApplication>
#include <QQmlContext>
#include <QSocketNotifier>
#include "windowmanager.h"

int main(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    app.setApplicationName("omp-qml-bridge");

    WindowManager manager;

    // Read JSON lines from stdin without blocking the Qt event loop.
    // QSocketNotifier fires whenever data is available on the fd.
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

    return app.exec();
}
