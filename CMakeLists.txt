cmake_minimum_required(VERSION 3.9)

project(qjs-debugger LANGUAGES NONE)

# main script: installed executable as bin/qjs-debugger, with a
# bin/qjsm-debugger symlink (the name selects the debuggee interpreter)
install(
  FILES qjs-debugger.js
  DESTINATION bin
  RENAME qjs-debugger
  PERMISSIONS OWNER_EXECUTE OWNER_WRITE OWNER_READ GROUP_EXECUTE GROUP_READ
              WORLD_EXECUTE WORLD_READ)

install(
  CODE "message(\"Create symlink '\$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/bin/qjsm-debugger' to 'qjs-debugger'\")
execute_process(COMMAND ${CMAKE_COMMAND} -E create_symlink qjs-debugger \$ENV{DESTDIR}${CMAKE_INSTALL_PREFIX}/bin/qjsm-debugger)"
)

# support modules imported relative to the script
install(FILES codec.js session.js engine-connection.js transport.js server-adapter.js vscode-dap.js connector-lws.js
        DESTINATION bin)

# gui mode (loaded dynamically by qjs-debugger -m gui)
install(FILES gui/main.js gui/theme.js gui/widgets.js gui/toolbar.js gui/source-pane.js gui/console-pane.js
              gui/stack-pane.js gui/vars-pane.js gui/file-picker.js gui/command-line.js gui/watch-pane.js
        DESTINATION bin/gui)

# server mode's browser UI (qjs-lws examples/debugger/demo.{html,js}, served
# statically at path 'examples/browser' relative to the installed script)
install(FILES examples/browser/demo.html examples/browser/demo.js DESTINATION bin/examples/browser)

# VS Code extension package (qjs-debugger-<version>.vsix), built on demand via
# `cmake --build build/native --target vsix` (or `ninja vsix`). Requires
# `npx`/`@vscode/vsce` to be available; not part of the default build.
find_program(NPX_EXECUTABLE npx)
if(NPX_EXECUTABLE)
  add_custom_target(
    vsix
    COMMAND ${NPX_EXECUTABLE} @vscode/vsce package --out ${CMAKE_CURRENT_BINARY_DIR}/
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Packaging qjs-debugger VS Code extension (.vsix)"
    VERBATIM)
else()
  message(STATUS "npx not found: 'vsix' target will not be available")
endif()
