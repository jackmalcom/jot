#!/bin/sh
set -eu

# Query the default route without sending traffic; publish this machine's LAN IP.
jot_lan_ip=$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')
if [ -z "$jot_lan_ip" ]; then
  echo "No IPv4 address found for the default route." >&2
  exit 1
fi
exec avahi-publish -a -R jot.local "$jot_lan_ip"
