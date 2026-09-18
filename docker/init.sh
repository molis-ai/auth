#!/bin/sh
set -eu
umask 077
# Persistent random credentials: restarts must not invalidate the database or outbox.
for target in /secrets/db/password /secrets/db/root-password; do
    if [ ! -s "$target" ]; then openssl rand -hex 32 > "$target"; fi
done
if [ ! -s /secrets/auth/mail-key ]; then
    openssl rand -base64 32 > /secrets/auth/mail-key
fi
cp /secrets/db/password /secrets/auth/db-password
if [ ! -s /secrets/mail/mailpit.crt ] || [ ! -s /secrets/mail/mailpit.key ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -subj '/CN=mailpit' -addext 'subjectAltName=DNS:mailpit' \
        -keyout /secrets/mail/mailpit.key -out /secrets/mail/mailpit.crt 2>/dev/null
fi
# Import only the generated local SMTP certificate; never disable TLS verification.
cp "$JAVA_HOME/lib/security/cacerts" /secrets/auth/truststore
keytool -importcert -noprompt -alias local-mailpit -file /secrets/mail/mailpit.crt \
    -keystore /secrets/auth/truststore -storepass changeit >/dev/null 2>&1
chown -R 10001:10001 /secrets/auth
chmod 700 /secrets/auth
chmod 600 /secrets/auth/*
echo 'Local development credentials and SMTP trust are ready.'
