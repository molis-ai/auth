package ai.molis.auth.mail;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.AccountEventMapper;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.verification.EphemeralFailure;
import ai.molis.auth.verification.RedisMailboxProofs;
import ai.molis.auth.verification.VerifiedMailboxAccounts;
import java.net.URI;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real Redis + MySQL + production mail beans. Explicit development inbox replaces SMTP delivery only. */
@SpringBootTest(classes = AuthApplication.class, properties = {"auth.ephemeral.enabled=true", "auth.mail.enabled=true",
        "auth.mail.mode=inbox", "auth.mail.origin=http://localhost:8080", "auth.mail.worker.enabled=false", "server.address=127.0.0.1"})
class MailVerificationRedisIT {
    @Autowired MailboxMailService mail;
    @Autowired MailDispatcher dispatcher;
    @Autowired MailTransport transport;
    @Autowired RedisMailboxProofs proofs;
    @Autowired VerifiedMailboxAccounts accounts;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean AccountEventMapper events;

    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry properties) {
        properties.add("auth.mail.crypto.active-key-id", () -> "primary");
        properties.add("auth.mail.crypto.keys.primary", () -> MailSecurityTests.KEY);
        properties.add("spring.data.redis.host", () -> "127.0.0.1");
        properties.add("spring.data.redis.port", () -> {
            int port = Integer.parseInt(System.getProperty("auth.it.redis-port", "0"));
            if (port < 1024 || port > 65535 || port == 6379) throw new IllegalArgumentException("Dedicated loopback Redis port required");
            return port;
        });
        properties.add("spring.data.redis.username", () -> ""); properties.add("spring.data.redis.password", () -> "");
        properties.add("spring.data.redis.ssl.enabled", () -> false);
        properties.add("spring.datasource.url", () -> {
            String url = System.getProperty("auth.it.jdbc-url", "");
            if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))
                throw new IllegalArgumentException("A local disposable auth_test_* database is required");
            return url;
        });
        properties.add("spring.datasource.username", () -> System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"));
        properties.add("spring.datasource.password", () -> System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
    }

    @Test void inboxDeliverySuppliesTheSecretMissingFromInitiatingResponse() {
        String email = id() + "@example.test", binding = TokenSecrets.generate();
        var pending = mail.request(email, RedisMailboxProofs.Purpose.REGISTER, binding, "zh-CN", id(), id());
        String messageId = jdbc.queryForObject("SELECT id FROM auth_mail_outbox WHERE recipient_email = ?", String.class, email);
        String encrypted = jdbc.queryForObject("SELECT payload_encrypted FROM auth_mail_outbox WHERE id = ?", String.class, messageId);
        assertThat(encrypted).startsWith("v1.primary.").doesNotContain(pending.challenge(), binding);
        assertThatThrownBy(() -> accounts.register(pending.challenge(), binding, "Mail Test", "a mail delivered password", "zh-CN", id()))
                .isInstanceOf(EphemeralFailure.class);
        assertThat(dispatcher.dispatch(messageId)).isTrue();
        var delivered = ((DevelopmentInbox) transport).messages().stream().filter(message -> message.id().equals(messageId)).findFirst().orElseThrow();
        String link = delivered.body().lines().filter(line -> line.startsWith("http://localhost:8080/verify-email#")).findFirst().orElseThrow();
        var uri = URI.create(link);
        assertThat(uri.getQuery()).isNull();
        String token = uri.getFragment().split("&token=")[1];
        assertThat(new tools.jackson.databind.json.JsonMapper().writeValueAsString(pending)).doesNotContain(token, "deliverySecret");
        assertThat(encrypted).doesNotContain(token);
        proofs.verifyLink(pending.challenge(), token);
        assertThat(accounts.register(pending.challenge(), binding, "Mail Test", "a mail delivered password", "zh-CN", id())).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT payload_encrypted FROM auth_mail_outbox WHERE id = ?", String.class, messageId)).isNull();
    }

    @Test void requestsUseSharedMailboxLimitAndNeverQueueOverLimit() {
        String email = id() + "@example.test", binding = TokenSecrets.generate(), address = id();
        for (int i = 0; i < 3; i++) mail.request(email, RedisMailboxProofs.Purpose.REGISTER, binding, "en", address, id());
        assertThatThrownBy(() -> mail.request(email.toUpperCase(java.util.Locale.ROOT), RedisMailboxProofs.Purpose.REGISTER,
                binding, "en", address, id())).isInstanceOfSatisfying(EphemeralFailure.class,
                failure -> assertThat(failure.reason()).isEqualTo(EphemeralFailure.Reason.RATE_LIMITED));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", Integer.class, email)).isEqualTo(3);
    }

    @Test void failedAuditRollsBackVerificationMailQueue() {
        String email = id() + "@example.test", requestId = id();
        doThrow(new DataAccessResourceFailureException("test-only audit failure")).when(events)
                .audit(anyString(), eq("mail.verification.request"), anyString(), isNull(), isNull(), eq(requestId), any());
        assertThatThrownBy(() -> mail.request(email, RedisMailboxProofs.Purpose.REGISTER, TokenSecrets.generate(), "en", id(), requestId))
                .isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", Integer.class, email)).isZero();
    }
    private static String id() { return UUID.randomUUID().toString(); }
}
