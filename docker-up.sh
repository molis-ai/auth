#!/bin/sh
# Run with: sh docker-up.sh. Only Docker is required on the host.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v docker >/dev/null 2>&1 && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
    PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    export PATH
fi
if ! command -v docker >/dev/null 2>&1; then
    echo 'Install Docker Desktop (or Docker Engine + Compose) first.' >&2
    exit 1
fi
# BuildKit authentication runs in the CLI and does not inherit macOS GUI proxy
# settings. Reuse an existing HTTPS system proxy for this process only.
if [ "$(uname -s)" = Darwin ] && [ -z "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
    proxy_settings=$(scutil --proxy)
    proxy_enabled=$(printf '%s\n' "$proxy_settings" | awk '$1 == "HTTPSEnable" {print $3}')
    proxy_host=$(printf '%s\n' "$proxy_settings" | awk '$1 == "HTTPSProxy" {print $3}')
    proxy_port=$(printf '%s\n' "$proxy_settings" | awk '$1 == "HTTPSPort" {print $3}')
    if [ "$proxy_enabled" = 1 ] && [ -n "$proxy_host" ] && [ -n "$proxy_port" ]; then
        HTTPS_PROXY="http://$proxy_host:$proxy_port"
        export HTTPS_PROXY
        echo 'Using the existing macOS HTTPS proxy for this Docker command only.'
    fi
fi
if ! docker info >/dev/null 2>&1; then
    echo 'Docker engine is not ready. Open Docker Desktop and wait for it to start.' >&2
    exit 1
fi
docker compose up --build -d --wait
printf '\nAuth: http://localhost:8080/console\nMail: http://localhost:8025\n'
