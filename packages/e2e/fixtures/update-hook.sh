#!/bin/sh
# The remote's update hook: the host rule (design §4.1 #1) on a local bare
# remote, which has no authenticated pusher, so the new tip's committer stands
# in for it. Only the lander identity may move main, and main can't be
# deleted. Every update of main that reaches the hook is logged first,
# refused or not (trunk-updates.log in the remote).
ref="$1"
new="$3"
case "$ref" in
  refs/heads/main)
    echo "$new" >> "$GIT_DIR/trunk-updates.log"
    case "$new" in
      0000000000000000000000000000000000000000) echo "main can't be deleted" >&2; exit 1 ;;
    esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "agenthub lander <lander@localhost>" ]; then
      echo "only the lander may update main (committer: $who)" >&2
      exit 1
    fi
    ;;
esac
exit 0
