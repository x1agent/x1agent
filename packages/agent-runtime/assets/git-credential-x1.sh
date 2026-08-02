#!/bin/sh
# Git credential helper — fetches a username / token pair from the
# sidecar on localhost:9090. Git invokes this with "get", "store", or
# "erase"; we only implement "get" (the sidecar owns token lifetime).
#
# See docs/security/credential-proxy.md.

case "$1" in
  get)
    host=""
    while IFS='=' read -r key value; do
      [ -z "$key" ] && break
      case "$key" in
        host) host="$value" ;;
      esac
    done

    resp=$(curl -sf "http://localhost:9090/git/credential?host=${host}" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$resp" ]; then
      exit 1
    fi

    username=$(echo "$resp" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
    password=$(echo "$resp" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p')

    if [ -n "$username" ] && [ -n "$password" ]; then
      echo "username=$username"
      echo "password=$password"
    else
      exit 1
    fi
    ;;
  store|erase)
    # No-op — sidecar owns token lifecycle.
    ;;
esac
