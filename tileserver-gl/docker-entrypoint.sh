#!/bin/bash
if ! which -- "${1}"; then
  # first arg is not an executable
  # The light image renders nothing server-side and ships no X server.
  if command -v Xvfb >/dev/null 2>&1; then
    if [ -e /tmp/.X99-lock ]; then rm /tmp/.X99-lock -f; fi
    export DISPLAY=:99
    # Filter out harmless xkbcomp keysym warnings (high keycodes for Wayland not supported in X11).
    # The subshell exits immediately after backgrounding Xvfb, so Xvfb (and the
    # log-filter grep) reparent to the init (tini, PID 1) and get reaped when they
    # exit — otherwise they linger as zombies under the exec'd node below.
    ( Xvfb "${DISPLAY}" -nolisten unix 2> >(grep -vE "(Could not resolve keysym|XKEYBOARD keymap compiler|xkbcomp are not fatal)" >&2) & )
  fi
  exec node /usr/src/app/ "$@"
fi

exec "$@"
