#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an Orca install dir — never delete an unrelated
# /usr/bin/orca-ide a user or other package may own.
set -e

# Why: on an RPM upgrade the new package's %post recreates this symlink BEFORE
# the old package's %postun runs, so removing it unconditionally here deletes the
# link the upgrade just installed (orca-ide drops off PATH). Only remove on a
# genuine uninstall, never during an upgrade. RPM passes $1 as a remaining-
# instance count ("0" == final erase, >=1 == upgrade); dpkg passes an action word
# ("remove"/"purge" == uninstall, "upgrade" == upgrade).
case "${1-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;
esac

link="/usr/bin/orca-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Orca/*|/opt/orca-ide/*|/opt/orca/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
