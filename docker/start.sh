#!/bin/sh
set -eu
export AUTH_DB_PASSWORD="$(cat /secrets/db-password)"
export AUTH_MAIL_KEY="$(cat /secrets/mail-key)"
# The public listener is host-loopback-only in Compose. Java accepts HTTP only
# from this same-container loopback proxy; no forwarded-header trust is enabled.
nginx -c /app/docker/nginx.conf
exec java -Djavax.net.ssl.trustStore=/secrets/truststore \
    -Djavax.net.ssl.trustStorePassword=changeit -jar /app/auth.jar
