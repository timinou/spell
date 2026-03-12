cmake_minimum_required(VERSION 3.16)
project(spell-qml-bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick Network)

qt_add_executable(spell-qml-bridge
    bridge/main.cpp
    bridge/bridge.cpp
    bridge/windowmanager.cpp
    bridge/socketserver.cpp
)

target_link_libraries(spell-qml-bridge PRIVATE Qt6::Quick Qt6::Network)

install(TARGETS spell-qml-bridge DESTINATION .)
