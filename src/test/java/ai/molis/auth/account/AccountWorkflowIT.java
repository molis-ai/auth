package ai.molis.auth.account;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.persistence.MySqlTestDataSources;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionMapper;
import ai.molis.auth.session.SessionService;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.*;
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

/** Real persistence tests; verified mailbox proofs are internal fixtures, NOT live email verification. */
@SpringBootTest(classes = AuthApplication.class)
class AccountWorkflowIT {
    private static final String PASSWORD = "a unique test password phrase";
    private static final String NEW_PASSWORD = "another unique test password phrase";
    @Autowired LocalAccountService service;
    @MockitoSpyBean AccountOperationMapper operations;
    @Autowired AccountMapper accounts;
    @Autowired SessionService sessions;
    @Autowired JdbcTemplate jdbc;
    @Autowired org.springframework.transaction.PlatformTransactionManager transactions;
    @MockitoSpyBean AccountEventMapper events;
    @MockitoSpyBean PasswordHashing passwords;

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

    @Test void registrationCreatesCompleteAggregateAuditAndMail() {
        var f = register();
        var credential = operations.findCredential(f.email());
        assertThat(passwords.matches(PASSWORD, credential.passwordHash())).isTrue();
        assertThat(credential.passwordHash()).doesNotContain(PASSWORD);
        assertThat(count("SELECT COUNT(*) FROM auth_space WHERE personal_user_id = ?", f.user())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_membership WHERE user_id = ? AND role = 'OWNER'", f.user())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id = ? AND action = 'account.register'", f.user())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ? AND template_key = 'ACCOUNT_REGISTERED' AND locale = 'en' AND status = 'PENDING'", f.email())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ?", f.user())).isZero();
    }

    @Test void failedMailInsertRollsBackEntireRegistrationAndProofReceipt() {
        String operation = id(), email = email();
        var before = aggregateCounts();
        doThrow(new DataAccessResourceFailureException("test-only mail failure")).when(events)
                .mail(anyString(), eq(email), anyString(), anyString(), any());
        assertThatThrownBy(() -> register(operation, email)).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(operations.findCredential(email)).isNull();
        assertThat(operations.findReceipt(operation)).isNull();
        assertThat(aggregateCounts()).isEqualTo(before);
        reset(events);
        assertThat(register(operation, email)).isNotBlank();
    }

    @Test void failedAuditInsertAlsoRollsBackRegistration() {
        String operation = id(), email = email();
        doThrow(new DataAccessResourceFailureException("test-only audit failure")).when(events)
                .audit(anyString(), eq("account.register"), anyString(), anyString(), anyString(), anyString(), any());
        assertThatThrownBy(() -> register(operation, email)).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(operations.findReceipt(operation)).isNull();
        assertThat(operations.findCredential(email)).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", email)).isZero();
    }

    @Test void verifiedOperationIsIdempotentButCannotChangeMailboxOrPurpose() {
        var f = register();
        assertThat(register(f.operation(), f.email())).isEqualTo(f.user());
        rejects("INVALID_VERIFICATION", () -> register(f.operation(), email()));
        rejects("INVALID_VERIFICATION", () -> service.resetPasswordAfterMailboxVerification(f.operation(), f.email(), NEW_PASSWORD, "en", id()));
        rejects("ACCOUNT_EXISTS", () -> register(id(), f.email()));
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", f.email())).isEqualTo(1);
        assertThat(passwords.matches(PASSWORD, operations.findCredential(f.email()).passwordHash())).isTrue();
    }

    @RepeatedTest(3) void twoConcurrentRegistrationsOfOneProofReturnOneUser() throws Exception {
        String operation = id(), email = email();
        var other = secondNode();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var one = executor.submit(() -> { start.await(); return register(operation, email); });
            var two = executor.submit(() -> { start.await(); return other.registerAfterMailboxVerification(operation, email,
                    "Account test", PASSWORD, "en", id()); });
            start.countDown();
            assertThat(one.get(10, TimeUnit.SECONDS)).isEqualTo(two.get(10, TimeUnit.SECONDS));
        }
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email = ?", email)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", email)).isEqualTo(1);
    }

    @Test void correctPasswordCreatesRootAndAllCredentialFailuresAreGeneric() {
        var f = register();
        var login = service.login(f.email(), PASSWORD, true, id());
        assertThat(sessions.resolveBrowserAuthentication(login.cookieSecret())).contains(login.authenticationId());
        assertThat(jdbc.queryForObject("SELECT cookie_hash FROM auth_authentication_session WHERE id = ?", String.class,
                login.authenticationId())).isEqualTo(TokenSecrets.digest(login.cookieSecret()));
        rejects("INVALID_CREDENTIALS", () -> service.login(f.email(), "wrong password phrase", true, id()));
        rejects("INVALID_CREDENTIALS", () -> service.login(email(), PASSWORD, true, id()));
        sessions.disableUser(f.user());
        rejects("INVALID_CREDENTIALS", () -> service.login(f.email(), PASSWORD, true, id()));
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id = ? AND action = 'account.login' AND outcome = 'DENIED' AND actor_user_id IS NULL", f.user())).isEqualTo(2);
    }

    @Test void resetRevokesAllRootAndProductTokensAtomically() {
        var f = register();
        var root = service.login(f.email(), PASSWORD, true, id());
        var tokens = tokens(root.authenticationId());
        String operation = id();
        assertThat(service.resetPasswordAfterMailboxVerification(operation, f.email(), NEW_PASSWORD, "en", id())).isEqualTo(f.user());
        assertThat(sessions.resolveAccessForAuth(tokens.accessToken())).isEmpty();
        assertThat(sessions.resolveBrowserAuthentication(root.cookieSecret())).isEmpty();
        rejects("INVALID_CREDENTIALS", () -> service.login(f.email(), PASSWORD, true, id()));
        assertThat(service.login(f.email(), NEW_PASSWORD, false, id()).cookieSecret()).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ? AND template_key = 'PASSWORD_CHANGED'", f.email())).isEqualTo(1);
    }

    @Test void resetMailFailurePreservesOldCredentialAndSessions() {
        var f = register();
        var root = service.login(f.email(), PASSWORD, true, id());
        var tokens = tokens(root.authenticationId());
        String operation = id();
        doThrow(new DataAccessResourceFailureException("test-only failure")).when(events)
                .mail(anyString(), eq(f.email()), eq("PASSWORD_CHANGED"), anyString(), any());
        assertThatThrownBy(() -> service.resetPasswordAfterMailboxVerification(operation, f.email(), NEW_PASSWORD, "en", id()))
                .isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(operations.findReceipt(operation)).isNull();
        assertThat(passwords.matches(PASSWORD, operations.findCredential(f.email()).passwordHash())).isTrue();
        assertThat(sessions.resolveAccessForAuth(tokens.accessToken())).isPresent();
        assertThat(sessions.resolveBrowserAuthentication(root.cookieSecret())).isPresent();
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id = ? AND action = 'account.password.reset'", f.user())).isZero();
    }

    @Test void externalOnlyMailboxCannotAcquirePasswordThroughResetOrRegistration() {
        String user = id(), email = email();
        accounts.insertUser(user, "External account fixture");
        accounts.insertVerifiedEmail(id(), user, email);
        rejects("RESET_NOT_AVAILABLE", () -> service.resetPasswordAfterMailboxVerification(id(), email, NEW_PASSWORD, "en", id()));
        rejects("ACCOUNT_EXISTS", () -> register(id(), email));
        rejects("INVALID_CREDENTIALS", () -> service.login(email, PASSWORD, true, id()));
        assertThat(operations.findCredential(email).passwordHash()).isNull();
    }

    @Test void replayedResetReceiptDoesNotOverwriteLaterPasswordOrRevokeNewSession() {
        var f = register();
        String firstOperation = id();
        service.resetPasswordAfterMailboxVerification(firstOperation, f.email(), NEW_PASSWORD, "en", id());
        service.resetPasswordAfterMailboxVerification(id(), f.email(), PASSWORD, "en", id());
        var latest = service.login(f.email(), PASSWORD, true, id());
        service.resetPasswordAfterMailboxVerification(firstOperation, f.email(), NEW_PASSWORD, "en", id());
        assertThat(passwords.matches(PASSWORD, operations.findCredential(f.email()).passwordHash())).isTrue();
        assertThat(sessions.resolveBrowserAuthentication(latest.cookieSecret())).isPresent();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ? AND template_key = 'PASSWORD_CHANGED'", f.email())).isEqualTo(2);
    }

    @Test void passwordResetDuringKdfPreventsOldPasswordLogin() throws Exception {
        var f = register();
        var checked = new CountDownLatch(1);
        var continueLogin = new CountDownLatch(1);
        doAnswer(invocation -> {
            boolean match = (boolean) invocation.callRealMethod();
            checked.countDown();
            if (!continueLogin.await(10, TimeUnit.SECONDS)) throw new AssertionError("Reset never released login");
            return match;
        }).when(passwords).matches(eq(PASSWORD), anyString());
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var login = executor.submit(() -> {
                rejects("INVALID_CREDENTIALS", () -> service.login(f.email(), PASSWORD, true, id()));
            });
            try {
                assertThat(checked.await(10, TimeUnit.SECONDS)).isTrue();
                service.resetPasswordAfterMailboxVerification(id(), f.email(), NEW_PASSWORD, "en", id());
            } finally { continueLogin.countDown(); }
            login.get(10, TimeUnit.SECONDS);
        }
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ?", f.user())).isZero();
    }

    @Test void concurrentResetRetriesAcrossNodesProduceOneNotification() throws Exception {
        var f = register();
        String operation = id();
        var other = secondNode();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var one = executor.submit(() -> { start.await(); return service.resetPasswordAfterMailboxVerification(
                    operation, f.email(), NEW_PASSWORD, "en", id()); });
            var two = executor.submit(() -> { start.await(); return other.resetPasswordAfterMailboxVerification(
                    operation, f.email(), NEW_PASSWORD, "en", id()); });
            start.countDown();
            assertThat(one.get(10, TimeUnit.SECONDS)).isEqualTo(f.user());
            assertThat(two.get(10, TimeUnit.SECONDS)).isEqualTo(f.user());
        }
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ? AND template_key = 'PASSWORD_CHANGED'", f.email())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id = ? AND action = 'account.password.reset'", f.user())).isEqualTo(1);
    }

    @Test void registrationCommittedBetweenReceiptAndMailboxReadsIsStillIdempotent() throws Exception {
        String operation = id(), email = email();
        var other = secondNode();
        var firstReceiptRead = new CountDownLatch(1);
        var otherCommitted = new CountDownLatch(1);
        doAnswer(invocation -> {
            // The mapper is a JDK MyBatis proxy; Mockito callRealMethod cannot invoke its
            // abstract interface method. Read on this same transaction's JDBC connection.
            var result = jdbc.query("SELECT operation_id, purpose, canonical_email, user_id FROM auth_account_operation WHERE operation_id = ?",
                    (row, index) -> new AccountOperationMapper.Receipt(row.getString(1), row.getString(2), row.getString(3), row.getString(4)),
                    operation).stream().findFirst().orElse(null);
            if (result == null) {
                firstReceiptRead.countDown();
                if (!otherCommitted.await(10, TimeUnit.SECONDS)) throw new AssertionError("Other node did not commit");
            }
            return result;
        }).when(operations).findReceipt(operation);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var firstRegistration = executor.submit(() -> register(operation, email));
            String otherUser;
            try {
                assertThat(firstReceiptRead.await(10, TimeUnit.SECONDS)).isTrue();
                otherUser = other.registerAfterMailboxVerification(operation, email, "Test", PASSWORD, "en", id());
            } finally { otherCommitted.countDown(); }
            assertThat(firstRegistration.get(10, TimeUnit.SECONDS)).isEqualTo(otherUser);
        }
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email = ?", email)).isEqualTo(1);
    }

    @Test void loginDenialAuditSurvivesCallerRollback() {
        var f = register();
        assertThatThrownBy(() -> new org.springframework.transaction.support.TransactionTemplate(transactions).execute(status -> {
            service.login(f.email(), "incorrect test password", true, id());
            return null;
        })).isInstanceOf(LocalAccountService.AccountRejectedException.class);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id = ? AND action = 'account.login' AND outcome = 'DENIED'", f.user())).isEqualTo(1);
    }

    @Test void auditFailureDoesNotCreateSuccessfulLoginSession() {
        var f = register();
        doThrow(new DataAccessResourceFailureException("test-only audit failure")).when(events)
                .audit(anyString(), eq("account.login"), eq("SUCCESS"), anyString(), anyString(), anyString(), any());
        assertThatThrownBy(() -> service.login(f.email(), PASSWORD, true, id())).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ?", f.user())).isZero();
    }

    private List<Long> aggregateCounts() {
        return List.of("auth_user", "auth_user_email", "auth_local_credential", "auth_space", "auth_membership",
                "auth_account_operation", "auth_audit_event", "auth_mail_outbox").stream()
                .map(table -> jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class)).toList();
    }

    private LocalAccountService secondNode() throws Exception {
        var source = MySqlTestDataSources.create(System.getProperty("auth.it.jdbc-url"),
                System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"), System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
        var builder = new org.mybatis.spring.SqlSessionFactoryBean();
        builder.setDataSource(source);
        var factory = builder.getObject();
        factory.getConfiguration().setLocalCacheScope(org.apache.ibatis.session.LocalCacheScope.STATEMENT);
        factory.getConfiguration().setCacheEnabled(false);
        for (Class<?> mapper : List.of(AccountMapper.class, AccountOperationMapper.class, AccountEventMapper.class, SessionMapper.class))
            factory.getConfiguration().addMapper(mapper);
        var template = new org.mybatis.spring.SqlSessionTemplate(factory);
        return new LocalAccountService(template.getMapper(AccountMapper.class), template.getMapper(AccountOperationMapper.class),
                template.getMapper(AccountEventMapper.class), template.getMapper(SessionMapper.class), new PasswordHashing(),
                java.time.Clock.systemUTC(), new org.springframework.jdbc.datasource.DataSourceTransactionManager(source));
    }

    private SessionService.TokenPair tokens(String authentication) {
        String application = id(), client = "account-test-" + id();
        jdbc.update("INSERT INTO auth_application(id, name, status) VALUES (?, 'Account workflow test', 'ACTIVE')", application);
        jdbc.update("INSERT INTO auth_login_client(id, client_id, application_id, client_type, status, allowed_scopes) VALUES (?, ?, ?, 'WEB', 'ACTIVE', 'account')", id(), client, application);
        return sessions.issueInitial(sessions.createGrant(authentication, client, Set.of("account")));
    }
    private Fixture register() {
        String operation = id(), email = email();
        return new Fixture(operation, email, register(operation, email));
    }
    private String register(String operation, String email) {
        return service.registerAfterMailboxVerification(operation, email, "Account test", PASSWORD, "en", id());
    }
    private int count(String sql, String value) { return jdbc.queryForObject(sql, Integer.class, value); }
    private static void rejects(String code, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOf(LocalAccountService.AccountRejectedException.class).hasMessage(code);
    }
    private static String id() { return UUID.randomUUID().toString(); }
    private static String email() { return id() + "@example.test"; }
    private record Fixture(String operation, String email, String user) {}
}
