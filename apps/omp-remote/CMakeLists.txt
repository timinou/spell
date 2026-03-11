cmake_minimum_required(VERSION 3.21)
project(omp-remote LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick WebSockets)

set(BRIDGE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../packages/qml/bridge)

qt_add_executable(omp-remote
    src/main.cpp
    src/remoteclient.cpp
    src/panelmanager.cpp
    ${BRIDGE_DIR}/bridge.cpp
)

target_include_directories(omp-remote PRIVATE src ${BRIDGE_DIR})
target_link_libraries(omp-remote PRIVATE Qt6::Quick Qt6::WebSockets)

qt_add_qml_module(omp-remote
    URI OmpRemote
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/ChatView.qml
        qml/MessageDelegate.qml
        qml/ToolCallCard.qml
        qml/PanelDrawer.qml
)

if(ANDROID)
    set_property(TARGET omp-remote PROPERTY QT_ANDROID_PACKAGE_SOURCE_DIR
        ${CMAKE_CURRENT_SOURCE_DIR}/android)
endif()
