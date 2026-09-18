FROM node:22-bookworm-slim AS node
FROM eclipse-temurin:21-jdk-jammy AS build
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/root/.m2 --mount=type=cache,target=/root/.npm \
    chmod +x mvnw && ./mvnw -B -ntp -Pweb package

FROM eclipse-temurin:21-jre-jammy AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends nginx openssl curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 auth && useradd --uid 10001 --gid auth --no-create-home auth
WORKDIR /app
COPY --from=build /workspace/target/auth-0.0.1-SNAPSHOT.jar /app/auth.jar
COPY docker/ /app/docker/
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/app/docker/start.sh"]
