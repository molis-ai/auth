package ai.molis.auth.verification;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.AccountEventMapper;
import ai.molis.auth.account.AccountOperationMapper;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import static ai.molis.auth.verification.EphemeralFailure.Reason.*;
import static ai.molis.auth.verification.RedisMailboxProofs.Purpose.*;
import static ai.molis.auth.verification.ProofSecurityRedisIT.rejects;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real Redis -> MySQL workflow. Delivery secrets still come from a test fixture, not SMTP. */
@SpringBootTest(classes = AuthApplication.class, properties = "auth.ephemeral.enabled=true")
class MailboxWorkflowRedisIT {
    private static final String PASSWORD = "verified mailbox test passphrase";
    @Autowired RedisMailboxProofs proofs;
    @Autowired VerifiedMailboxAccounts workflow;
    @Autowired LocalAccountService accounts;
    @Autowired AccountOperationMapper operations;
    @Autowired SessionService sessions;
    @MockitoSpyBean AccountEventMapper events;

    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.data.redis.host", () -> "127.0.0.1");
        properties.add("spring.data.redis.port", RedisTestConnections::port);
        properties.add("spring.data.redis.username", () -> "");
        properties.add("spring.data.redis.password", () -> "");
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

    @Test void unverifiedEmailCannotRegisterAndVerifiedProofWorksOnlyOnce() {
        String email = id() + "@example.test", binding = TokenSecrets.generate();
        var issued = proofs.issue(email, REGISTER, binding);
        rejects(INVALID_PROOF, () -> workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id()));
        assertThat(operations.findCredential(email)).isNull();
        proofs.verifyLink(issued.challenge(), issued.deliverySecret());
        String user = workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id());
        assertThat(operations.findCredential(email).userId()).isEqualTo(user);
        rejects(INVALID_PROOF, () -> workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id()));
    }

    @Test void verifiedResetRevokesSessionAndWrongPurposeCannotBeUsed() {
        String email = id() + "@example.test", binding = TokenSecrets.generate();
        accounts.registerAfterMailboxVerification(id(), email, "Test", PASSWORD, "en", id());
        var login = accounts.login(email, PASSWORD, true, id());
        var issued = proofs.issue(email, PASSWORD_RESET, binding);
        proofs.verifyLink(issued.challenge(), issued.deliverySecret());
        rejects(INVALID_PROOF, () -> workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id()));
        workflow.resetPassword(issued.challenge(), binding, "a new verified reset password", "en", id());
        assertThat(sessions.resolveBrowserAuthentication(login.cookieSecret())).isEmpty();
        assertThat(accounts.login(email, "a new verified reset password", false, id())).isNotNull();
    }

    @Test void databaseFailureDoesNotRestoreConsumedProofOrCreatePartialUser() {
        String email = id() + "@example.test", binding = TokenSecrets.generate();
        var issued = proofs.issue(email, REGISTER, binding);
        proofs.verifyLink(issued.challenge(), issued.deliverySecret());
        doThrow(new DataAccessResourceFailureException("test-only failed mail insert")).when(events)
                .mail(anyString(), eq(email), anyString(), anyString(), any());
        assertThatThrownBy(() -> workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id()))
                .isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(operations.findCredential(email)).isNull();
        rejects(INVALID_PROOF, () -> workflow.register(issued.challenge(), binding, "Test", PASSWORD, "en", id()));
        reset(events);
        var fresh = proofs.issue(email, REGISTER, binding);
        proofs.verifyLink(fresh.challenge(), fresh.deliverySecret());
        assertThat(workflow.register(fresh.challenge(), binding, "Test", PASSWORD, "en", id())).isNotBlank();
    }
    private static String id() { return UUID.randomUUID().toString(); }
}
