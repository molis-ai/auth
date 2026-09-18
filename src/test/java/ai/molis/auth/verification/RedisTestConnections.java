package ai.molis.auth.verification;

import java.time.Duration;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;

final class RedisTestConnections {
    private RedisTestConnections() {}
    static int port() {
        int port = Integer.parseInt(System.getProperty("auth.it.redis-port", "0"));
        if (port < 1024 || port > 65535 || port == 6379)
            throw new IllegalArgumentException("Supply a dedicated loopback Redis test port via auth.it.redis-port (not 6379)");
        return port;
    }
    static LettuceConnectionFactory open() {
        var server = new RedisStandaloneConfiguration("127.0.0.1", port());
        var client = LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(1))
                .shutdownTimeout(Duration.ofMillis(100)).build();
        var factory = new LettuceConnectionFactory(server, client);
        factory.afterPropertiesSet(); factory.start();
        return factory;
    }
}
