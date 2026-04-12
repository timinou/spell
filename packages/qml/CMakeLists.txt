cmake_minimum_required(VERSION 3.16)
project(spell-qml-bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick Network WebEngineQuick Widgets Svg)

set(SPELL_REPO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(PI_TYPST_SURFACE_TARGET_DIR ${CMAKE_CURRENT_BINARY_DIR}/rust-target)
set(PI_TYPST_SURFACE_LIB_NAME ${CMAKE_STATIC_LIBRARY_PREFIX}pi_typst_surface${CMAKE_STATIC_LIBRARY_SUFFIX})

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(PI_TYPST_SURFACE_PROFILE debug)
    set(PI_TYPST_SURFACE_BUILD_ARGS cargo build -p pi-typst-surface)
else()
    set(PI_TYPST_SURFACE_PROFILE release)
    set(PI_TYPST_SURFACE_BUILD_ARGS cargo build -p pi-typst-surface --release)
endif()

set(PI_TYPST_SURFACE_LIB ${PI_TYPST_SURFACE_TARGET_DIR}/${PI_TYPST_SURFACE_PROFILE}/${PI_TYPST_SURFACE_LIB_NAME})

add_custom_command(
    OUTPUT ${PI_TYPST_SURFACE_LIB}
    COMMAND ${CMAKE_COMMAND} -E env CARGO_TARGET_DIR=${PI_TYPST_SURFACE_TARGET_DIR} ${PI_TYPST_SURFACE_BUILD_ARGS}
    WORKING_DIRECTORY ${SPELL_REPO_ROOT}
    COMMENT "Building pi-typst-surface Rust crate"
    VERBATIM
)

add_custom_target(pi-typst-surface-build DEPENDS ${PI_TYPST_SURFACE_LIB})

add_library(pi_typst_surface STATIC IMPORTED GLOBAL)
set_target_properties(pi_typst_surface PROPERTIES IMPORTED_LOCATION ${PI_TYPST_SURFACE_LIB})
add_dependencies(pi_typst_surface pi-typst-surface-build)

qt_add_executable(spell-qml-bridge
    bridge/main.cpp
    bridge/bridge.cpp
    bridge/windowmanager.cpp
    bridge/socketserver.cpp
    bridge/systray.cpp
    bridge/hotkey.cpp
    bridge/hotkey.h
    native/typstdocumentitem.cpp
    native/typstdocumentitem.h
)

target_include_directories(spell-qml-bridge PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/native)

target_link_libraries(spell-qml-bridge PRIVATE Qt6::Quick Qt6::Network Qt6::WebEngineQuick Qt6::Widgets Qt6::Svg pi_typst_surface)

if(APPLE)
    target_link_libraries(spell-qml-bridge PRIVATE "-framework Carbon")
endif()

if(UNIX AND NOT APPLE)
    target_link_libraries(spell-qml-bridge PRIVATE dl m pthread)
endif()

install(TARGETS spell-qml-bridge DESTINATION .)