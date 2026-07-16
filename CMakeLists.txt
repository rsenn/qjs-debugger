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
install(FILES codec.js session.js engine-connection.js DESTINATION bin)
