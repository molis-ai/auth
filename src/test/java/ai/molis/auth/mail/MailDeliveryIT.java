package ai.molis.auth.mail;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.persistence.MySqlTestDataSources;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.assertj.core.api.Assertions.*;

@SpringBootTest(classes = AuthApplication.class)
class MailDeliveryIT {
    @Autowired MailOutboxMapper mapper;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactions;

    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> {
            String url = System.getProperty("auth.it.jdbc-url", "");
            if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))
                throw new IllegalArgumentException("A local disposable auth_test_* database is required");
            return url;
        });
        properties.add("spring.datasource.username", () -> System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"));
        properties.add("spring.datasource.password", () -> System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
    }

    @Test void successRunsOutsideCallerTransactionAndClearsLease() {
        String id = queue();
        var inbox = new DevelopmentInbox();
        var dispatcher = dispatcher(message -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            inbox.send(message);
        });
        new TransactionTemplate(transactions).executeWithoutResult(status -> assertThat(dispatcher.dispatch(id)).isTrue());
        assertThat(state(id)).isEqualTo("SENT");
        assertThat(inbox.messages()).hasSize(1);
        assertThat(jdbc.queryForObject("SELECT lease_token FROM auth_mail_outbox WHERE id = ?", String.class, id)).isNull();
        assertThat(dispatcher.dispatch(id)).isFalse();
    }

    @Test void deliveryRetriesAreFiniteAndHaveBackoff() {
        String id = queue(); var attempts = new AtomicInteger();
        var dispatcher = dispatcher(message -> { attempts.incrementAndGet(); throw new MailTransport.DeliveryFailed(); });
        for (int attempt = 1; attempt <= 5; attempt++) {
            assertThat(dispatcher.dispatch(id)).isTrue();
            assertThat(state(id)).isEqualTo(attempt == 5 ? "FAILED" : "PENDING");
            assertThat(jdbc.queryForObject("SELECT attempts FROM auth_mail_outbox WHERE id = ?", Integer.class, id)).isEqualTo(attempt);
            if (attempt < 5) {
                assertThat(dispatcher.dispatch(id)).isFalse();
                makeDue(id);
            }
        }
        assertThat(dispatcher.dispatch(id)).isFalse();
        assertThat(attempts).hasValue(5);
        assertThat(jdbc.queryForObject("SELECT last_error_code FROM auth_mail_outbox WHERE id = ?", String.class, id)).isEqualTo("DELIVERY_FAILED");
    }

    @Test void expiredAndTamperedProtectedMailAreNeverSent() {
        var inbox = new DevelopmentInbox(); var dispatcher = dispatcher(inbox);
        var cipher = MailSecurityTests.cipher();
        String expired = UUID.randomUUID().toString();
        mapper.enqueue(new MailOutboxMapper.Row(expired, "person@example.test", "VERIFY_REGISTER", "en", "unreadable",
                mapper.databaseNow().minusSeconds(1), 0));
        dispatcher.dispatch(expired);
        assertThat(state(expired)).isEqualTo("FAILED");
        String id = UUID.randomUUID().toString();
        var metadata = new MailOutboxMapper.Row(id, "person@example.test", "VERIFY_REGISTER", "en", null,
                mapper.databaseNow().plusSeconds(60), 0);
        String payload = cipher.seal(ai.molis.auth.security.TokenSecrets.generate() + "\n" + ai.molis.auth.security.TokenSecrets.generate(), metadata.context());
        mapper.enqueue(new MailOutboxMapper.Row(id, "different@example.test", metadata.template(), metadata.locale(), payload, metadata.expiresAt(), 0));
        dispatcher.dispatch(id);
        assertThat(state(id)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT payload_encrypted FROM auth_mail_outbox WHERE id = ?", String.class, id)).isNull();
        assertThat(inbox.messages()).isEmpty();
    }

    @Test void secondNodeCannotClaimLiveLeaseButCanDeliverOtherMail() throws Exception {
        String id = queue(), otherId = queue();
        var started = new CountDownLatch(1); var finish = new CountDownLatch(1);
        var inbox = new DevelopmentInbox();
        var one = dispatcher(message -> { started.countDown(); await(finish); inbox.send(message); });
        var two = secondNode(inbox);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> one.dispatch(id));
            try {
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(two.dispatch(id)).isFalse();
                assertThat(two.dispatch(otherId)).isTrue();
            } finally { finish.countDown(); }
            assertThat(first.get(5, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(inbox.messages()).hasSize(2);
        assertThat(state(id)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("SELECT attempts FROM auth_mail_outbox WHERE id = ?", Integer.class, id)).isEqualTo(1);
    }

    @Test void expiredLeaseCanBeReclaimedAndOldAcknowledgementIsFenced() throws Exception {
        String id = queue(); var started = new CountDownLatch(1); var finish = new CountDownLatch(1);
        var sends = new AtomicInteger();
        var one = dispatcher(message -> { started.countDown(); await(finish); sends.incrementAndGet(); });
        var two = secondNode(message -> sends.incrementAndGet());
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> one.dispatch(id));
            try {
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                String oldLease = jdbc.queryForObject("SELECT lease_token FROM auth_mail_outbox WHERE id = ?", String.class, id);
                jdbc.update("UPDATE auth_mail_outbox SET lease_until = CURRENT_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ?", id);
                assertThat(two.dispatch(id)).isTrue();
                assertThat(mapper.failed(id, oldLease, "PENDING", "DELIVERY_FAILED", 15)).isZero();
            } finally { finish.countDown(); }
            assertThat(first.get(5, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(state(id)).isEqualTo("SENT");
        assertThat(sends).hasValue(2); // Demonstrates the documented at-least-once SMTP boundary, not exactly-once.
        assertThat(jdbc.queryForObject("SELECT attempts FROM auth_mail_outbox WHERE id = ?", Integer.class, id)).isEqualTo(2);
    }

    @Test void workerCrashAtFinalAttemptDoesNotCreateInfiniteRetries() {
        String id = queue();
        jdbc.update("UPDATE auth_mail_outbox SET status='SENDING', attempts=5, lease_token=?, lease_until=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?", UUID.randomUUID().toString(), id);
        var inbox = new DevelopmentInbox();
        assertThat(dispatcher(inbox).dispatch(id)).isTrue();
        assertThat(state(id)).isEqualTo("FAILED");
        assertThat(inbox.messages()).isEmpty();
    }

    private String queue() {
        String id = UUID.randomUUID().toString();
        mapper.enqueue(new MailOutboxMapper.Row(id, "person@example.test", "ACCOUNT_REGISTERED", "en", null, null, 0));
        return id;
    }
    private MailDispatcher dispatcher(MailTransport transport) {
        return new MailDispatcher(mapper, new MailTemplates(MailSecurityTests.cipher(), "http://localhost:8080"), transport, transactions);
    }
    private MailDispatcher secondNode(MailTransport transport) throws Exception {
        var source = MySqlTestDataSources.create(System.getProperty("auth.it.jdbc-url"),
                System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"), System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
        var builder = new org.mybatis.spring.SqlSessionFactoryBean(); builder.setDataSource(source);
        var factory = builder.getObject();
        factory.getConfiguration().setLocalCacheScope(org.apache.ibatis.session.LocalCacheScope.STATEMENT);
        factory.getConfiguration().setCacheEnabled(false); factory.getConfiguration().addMapper(MailOutboxMapper.class);
        return new MailDispatcher(new org.mybatis.spring.SqlSessionTemplate(factory).getMapper(MailOutboxMapper.class),
                new MailTemplates(MailSecurityTests.cipher(), "http://localhost:8080"), transport,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(source));
    }
    private String state(String id) { return jdbc.queryForObject("SELECT status FROM auth_mail_outbox WHERE id = ?", String.class, id); }
    private void makeDue(String id) { jdbc.update("UPDATE auth_mail_outbox SET next_attempt_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=?", id); }
    private static void await(CountDownLatch latch) {
        try { if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("Worker was not released"); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
    }
}
