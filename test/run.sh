#!/bin/sh
# run.sh: batch-mode regression tests for qjs-debugger.
#
#   test/run.sh [INTERPRETER]      default qjsm; set UPDATE=1 to rewrite *.expected
#
# Each test/cases/NAME.dbg is fed to `qjs-debugger --plain -x` on the program in
# NAME.args (flags from NAME.flags). Output (pids normalised) must equal
# NAME.expected and the exit status NAME.status (default 0). Then the library,
# attach, DAP and server-mode checks run.
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
interp=${1:-qjsm}
sep=';'
export QUICKJS_MODULE_PATH="${QUICKJS_MODULE_PATH:-/usr/local/lib/quickjs$sep/usr/local/lib/$(uname -m)-linux-gnu/quickjs}"
dbg() { qjsm "$root/qjs-debugger.js" -i "$interp" "$@"; }
normalise() { sed -E 's/process [0-9]+/process N/; s/"pid":[0-9]+/"pid":0/'; }
pass=0 fail=0

check() { # name ok [detail]
  if [ "$2" = ok ]; then pass=$((pass + 1)); echo "ok   $1"; else fail=$((fail + 1)); echo "FAIL $1 $3"; fi
}

cd "$here/cases" || exit 2
for dbgfile in *.dbg; do
  name=${dbgfile%.dbg}
  flags=$(cat "$name.flags" 2>/dev/null)
  want=$(cat "$name.status" 2>/dev/null || echo 0)
  # shellcheck disable=SC2086
  timeout 60 qjsm "$root/qjs-debugger.js" -i "$interp" --plain $flags --timeout 50 -x "$dbgfile" "$(cat "$name.args")" > "$name.raw" 2>&1
  got=$?
  normalise < "$name.raw" > "$name.actual"
  rm -f "$name.raw"
  [ -n "$UPDATE" ] && cp "$name.actual" "$name.expected"
  if ! diff -u "$name.expected" "$name.actual" > "$name.diff"; then check "$name output" bad "(see test/cases/$name.diff)"
  elif [ "$got" != "$want" ]; then check "$name status" bad "(got $got, want $want)"
  else check "$name" ok; rm -f "$name.actual" "$name.diff"; fi
done

# library API
if timeout 60 qjsm "$here/lib.test.js" "$interp"; then check library ok; else check library bad; fi

# attach: the debuggee started elsewhere, debugger listens (-e) and connects (-e -c)
printf 'break f.js:3\nrun\nprint a\ncontinue\n' > "$here/attach.dbg"
(dbg -e --plain -a 127.0.0.1:9931 -x "$here/attach.dbg" > "$here/attach1.out" 2>&1) &
sleep 1.5
QUICKJS_DEBUG_ADDRESS=127.0.0.1:9931 "$interp" f.js > /dev/null
wait
grep -q '^\$1 = 20' "$here/attach1.out" && grep -q 'f () at f.js:3' "$here/attach1.out" && check attach-listen ok || check attach-listen bad "(see test/attach1.out)"
QUICKJS_DEBUG_LISTEN_ADDRESS=127.0.0.1:9932 "$interp" f.js > /dev/null &
sleep 1
dbg -e -c --plain -a 127.0.0.1:9932 -x "$here/attach.dbg" > "$here/attach2.out" 2>&1
wait
grep -q '^\$1 = 20' "$here/attach2.out" && grep -q 'f () at f.js:3' "$here/attach2.out" && check attach-connect ok || check attach-connect bad "(see test/attach2.out)"
rm -f "$here/attach.dbg" "$here/attach1.out" "$here/attach2.out"

# DAP adapter and server mode
if timeout 60 qjsm "$here/dap-client.js" "$interp" > /dev/null; then check dap ok; else check dap bad "(run: qjsm test/dap-client.js)"; fi
if python3 -c 'import websockets' 2>/dev/null; then
  if timeout 60 python3 "$here/server-client.py" "$interp" > /dev/null; then check server ok; else check server bad "(run: python3 test/server-client.py)"; fi
else echo "skip server (python3 websockets missing)"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
