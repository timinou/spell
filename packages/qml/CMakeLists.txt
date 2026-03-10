cmake_minimum_required(VERSION 3.16)
project(omp-qml-bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick)

qt_add_executable(omp-qml-bridge
    bridge/main.cpp
    bridge/bridge.cpp
    bridge/windowmanager.cpp
)

target_link_libraries(omp-qml-bridge PRIVATE Qt6::Quick)

install(TARGETS omp-qml-bridge DESTINATION .)
