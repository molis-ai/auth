package ai.molis.auth.session;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.persistence.MySqlTestDataSources;
import ai.molis.auth.security.TokenSecrets;
import java.time.*;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.*;
import org.mybatis.spring.SqlSessionFactoryBean;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static ai.molis.auth.session.SessionService.Reason.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@SpringBootTest(classes = AuthApplication.class)
@Import(SessionPersistenceIT.ClockConfig.class)
class SessionPersistenceIT {
    private static final Instant START = Instant.parse("2026-06-01T00:00:00Z");
    @Autowired SessionService service;
    @Autowired SessionMapper mapper;
    @Autowired AuthorizationCodeMapper codes;
    @Autowired AccountMapper accounts;
    @Autowired MutableClock clock;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactions;

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", SessionPersistenceIT::databaseUrl);
        properties.add("spring.datasource.username", () -> System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"));
        properties.add("spring.datasource.password", () -> System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
    }

    @BeforeEach
    void resetClock() { clock.current = START; }

    @Test
    void storesOnlyDigestsAndSurvivesASecondServiceInstance() throws Exception {
        var login = login();
        var tokens = login.tokens();
        assertThat(jdbc.queryForList("SELECT token_hash FROM auth_user_token WHERE session_id = ?", String.class,
                tokens.sessionId())).containsExactlyInAnyOrder(TokenSecrets.digest(tokens.accessToken()),
                TokenSecrets.digest(tokens.refreshToken()));
        assertThat(jdbc.queryForObject("SELECT cookie_hash FROM auth_authentication_session WHERE id = ?",
                String.class, login.authentication().authenticationId()))
                .isEqualTo(TokenSecrets.digest(login.authentication().cookieSecret()));
        var second = secondNode();
        assertThat(second.resolveAccessForApplication(tokens.accessToken(), login.client().applicationId()))
                .get().extracting(SessionService.UserPrincipal::userId).isEqualTo(login.userId());
        assertThat(second.resolveBrowserAuthentication(login.authentication().cookieSecret()))
                .contains(login.authentication().authenticationId());
        assertThat(second.resolveAccessForAuth(tokens.refreshToken())).isEmpty();
        assertThat(second.resolveAccessForAuth(TokenSecrets.digest(tokens.accessToken()))).isEmpty();
        assertThat(tokens.toString()).doesNotContain(tokens.accessToken(), tokens.refreshToken());
        assertThat(login.authentication().toString()).doesNotContain(login.authentication().cookieSecret());
    }

    @Test
    void accessTokenIsBoundToApplicationAndExpiresAtFifteenMinutes() {
        var login = login();
        assertThat(service.resolveAccessForApplication(login.tokens().accessToken(), id())).isEmpty();
        clock.current = START.plus(Duration.ofMinutes(15));
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
        var rotated = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
        assertThat(service.resolveAccessForAuth(rotated.accessToken())).isPresent();
    }

    @Test
    void oldRefreshReplayRevokesAllHistoricalAccessTokensAndCurrentRefresh() {
        var login = login();
        var second = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
        var third = service.rotate(login.client().clientId(), second.refreshToken(), Set.of());
        rejects(REPLAY, () -> service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of()));
        for (var tokens : List.of(login.tokens(), second, third)) {
            assertThat(service.resolveAccessForAuth(tokens.accessToken())).isEmpty();
        }
        rejects(INACTIVE, () -> service.rotate(login.client().clientId(), third.refreshToken(), Set.of()));
        assertThat(mapper.findRefresh(TokenSecrets.digest(login.tokens().refreshToken())).consumedAt()).isNotNull();
    }

    @Test
    void anotherClientCannotRotateOrRevokeVictimEvenUsingConsumedToken() {
        var login = login();
        var other = client();
        rejects(INVALID_GRANT, () -> service.rotate(other.clientId(), login.tokens().refreshToken(), Set.of()));
        var second = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
        rejects(INVALID_GRANT, () -> service.rotate(other.clientId(), login.tokens().refreshToken(), Set.of()));
        assertThat(service.resolveAccessForAuth(second.accessToken())).isPresent();
    }

    @Test
    void scopeExpansionFailsWithoutConsumingRefresh() {
        var login = login();
        rejects(INVALID_SCOPE, () -> service.rotate(login.client().clientId(),
                login.tokens().refreshToken(), Set.of("admin")));
        assertThat(mapper.findRefresh(TokenSecrets.digest(login.tokens().refreshToken())).consumedAt()).isNull();
        var narrowed = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of("account"));
        assertThat(service.resolveAccessForAuth(narrowed.accessToken())).get()
                .extracting(SessionService.UserPrincipal::scopes).isEqualTo(Set.of("account"));
    }

    @Test
    void backgroundRefreshDoesNotExtendIdleWindow() {
        var login = login();
        clock.current = START.plus(Duration.ofDays(29));
        var refreshed = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
        assertThat(refreshed.refreshExpiresAt()).isEqualTo(START.plus(Duration.ofDays(30)));
        assertThat(mapper.findAuthentication(login.authentication().authenticationId()).lastUserActivityAt()).isEqualTo(START);
        clock.current = START.plus(Duration.ofDays(30));
        rejects(INACTIVE, () -> service.rotate(login.client().clientId(), refreshed.refreshToken(), Set.of()));
        assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isEmpty();
        rejects(INACTIVE, () -> service.createGrant(login.authentication().authenticationId(),
                login.client().clientId(), Set.of("account")));
    }

    @Test
    void restorationAndInteractiveUseCannotResetOriginalNinetyDayLimit() {
        var login = login();
        var current = login.tokens();
        for (int day : new int[] {20, 40, 60, 80, 89}) {
            clock.current = START.plus(Duration.ofDays(day));
            current = service.rotate(login.client().clientId(), current.refreshToken(), Set.of());
            service.recordUserActivity(current.accessToken());
            current = service.rotate(login.client().clientId(), current.refreshToken(), Set.of());
        }
        String restoredGrant = service.createGrant(login.authentication().authenticationId(),
                login.client().clientId(), Set.of("account"));
        var restored = service.issueInitial(restoredGrant);
        assertThat(restored.refreshExpiresAt()).isEqualTo(START.plus(Duration.ofDays(90)));
        assertThat(mapper.findAuthentication(login.authentication().authenticationId()).authenticatedAt()).isEqualTo(START);
        clock.current = START.plus(Duration.ofDays(90));
        assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isEmpty();
        rejects(INACTIVE, () -> service.rotate(login.client().clientId(), restored.refreshToken(), Set.of()));
    }

    @Test
    void logoutOneGrantPreservesOtherDeviceAndAllLogoutRevokesRestoreCookies() {
        var login = login();
        var otherRoot = service.createAuthentication(login.userId(), true);
        var other = service.issueInitial(service.createGrant(otherRoot.authenticationId(),
                login.client().clientId(), Set.of("account")));
        service.revokeSession(login.userId(), login.tokens().sessionId());
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
        assertThat(service.resolveAccessForAuth(other.accessToken())).isPresent();
        assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isPresent();
        service.revokeAll(login.userId());
        assertThat(service.resolveAccessForAuth(other.accessToken())).isEmpty();
        assertThat(service.resolveBrowserAuthentication(otherRoot.cookieSecret())).isEmpty();
        assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isEmpty();
    }

    @Test
    void anotherUserCannotRevokeTheSession() {
        var login = login();
        rejects(INVALID_GRANT, () -> service.revokeSession(user(), login.tokens().sessionId()));
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isPresent();
    }

    @Test
    void disableAndRestoreUserDoesNotReviveExistingSessions() {
        var login = login();
        service.disableUser(login.userId());
        rejects(INACTIVE, () -> service.createAuthentication(login.userId(), true));
        jdbc.update("UPDATE auth_user SET status = 'ACTIVE' WHERE id = ?", login.userId());
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
        assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isEmpty();
        assertThat(service.createAuthentication(login.userId(), true)).isNotNull();
    }

    @Test
    void currentClientAndApplicationStateIsCheckedOnEveryResolution() {
        var login = login();
        jdbc.update("UPDATE auth_login_client SET status = 'DISABLED' WHERE client_id = ?", login.client().clientId());
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
        rejects(INACTIVE, () -> service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of()));
        jdbc.update("UPDATE auth_login_client SET status = 'ACTIVE' WHERE client_id = ?", login.client().clientId());
        jdbc.update("UPDATE auth_application SET status = 'DISABLED' WHERE id = ?", login.client().applicationId());
        assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
    }

    @Test
    void nativeAuthenticationHasNoBrowserRestoreCookieAndInitialIssuanceIsSingleUse() {
        String user = user();
        var client = client();
        var root = service.createAuthentication(user, false);
        assertThat(root.cookieSecret()).isNull();
        String grant = service.createGrant(root.authenticationId(), client.clientId(), Set.of("account"));
        service.issueInitial(grant);
        rejects(ALREADY_ISSUED, () -> service.issueInitial(grant));
        assertThat(tokenCount(grant)).isEqualTo(2);
    }

    @Test
    void failedNewRefreshInsertRollsBackConsumptionAndAccessInsertion() {
        var login = login();
        var faultyMapper = mock(SessionMapper.class, org.mockito.AdditionalAnswers.delegatesTo(mapper));
        doThrow(new DataAccessResourceFailureException("injected insert failure")).when(faultyMapper)
                .insertToken(anyString(), anyString(), eq("REFRESH"), anyString(), any(), any());
        var faulty = new SessionService(faultyMapper, codes, clock, transactions);
        assertThatThrownBy(() -> faulty.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of()))
                .isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(tokenCount(login.tokens().sessionId())).isEqualTo(2);
        assertThat(mapper.findRefresh(TokenSecrets.digest(login.tokens().refreshToken())).consumedAt()).isNull();
        assertThat(service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of())).isNotNull();
    }

    @Test
    void replayRevocationSurvivesTheCallingTransactionRollingBack() {
        var login = login();
        var latest = service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
        new TransactionTemplate(transactions).executeWithoutResult(status -> {
            rejects(REPLAY, () -> service.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of()));
            status.setRollbackOnly();
        });
        assertThat(service.resolveAccessForAuth(latest.accessToken())).isEmpty();
        assertThat(mapper.findGrant(login.tokens().sessionId()).revokedAt()).isNotNull();
    }

    @RepeatedTest(5)
    void twoIndependentDatabaseEntrypointsCannotBothConsumeSameRefresh() throws Exception {
        var login = login();
        var otherNode = secondNode();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> { start.await(); return attempt(service, login); });
            var second = executor.submit(() -> { start.await(); return attempt(otherNode, login); });
            start.countDown();
            assertThat(List.of(first.get(15, TimeUnit.SECONDS), second.get(15, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("SUCCESS", "REPLAY");
        }
        assertThat(tokenCount(login.tokens().sessionId())).isEqualTo(4);
        assertThat(mapper.findGrant(login.tokens().sessionId()).revokedAt()).isNotNull();
    }

    @RepeatedTest(5)
    void differentUsersOfTheSameClientCanRefreshWithoutConfigurationLockUpgrade() throws Exception {
        var firstLogin = login();
        String secondUser = user();
        var secondRoot = service.createAuthentication(secondUser, true);
        var secondTokens = service.issueInitial(service.createGrant(secondRoot.authenticationId(),
                firstLogin.client().clientId(), Set.of("account")));
        var secondLogin = new Login(secondUser, firstLogin.client(), secondRoot, secondTokens);
        var otherNode = secondNode();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> { start.await(); return attempt(service, firstLogin); });
            var second = executor.submit(() -> { start.await(); return attempt(otherNode, secondLogin); });
            start.countDown();
            assertThat(first.get(15, TimeUnit.SECONDS)).isEqualTo("SUCCESS");
            assertThat(second.get(15, TimeUnit.SECONDS)).isEqualTo("SUCCESS");
        }
    }

    @Test
    void userDisabledBetweenInitialLookupAndLockCannotReceiveFreshTokens() throws Exception {
        var login = login();
        var otherNode = secondNode();
        var hookedMapper = mock(SessionMapper.class, org.mockito.AdditionalAnswers.delegatesTo(mapper));
        doAnswer(invocation -> {
            try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
                executor.submit(() -> otherNode.disableUser(login.userId())).get(10, TimeUnit.SECONDS);
            }
            return mapper.lockUser(login.userId());
        }).when(hookedMapper).lockUser(login.userId());
        var node = new SessionService(hookedMapper, codes, clock, transactions);
        rejects(INACTIVE, () -> node.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of()));
        assertThat(tokenCount(login.tokens().sessionId())).isEqualTo(2);
    }

    @Test
    void identityReadsDoNotReuseAnOuterRepeatableReadSnapshot() throws Exception {
        var login = login();
        var otherNode = secondNode();
        var outer = new TransactionTemplate(transactions);
        outer.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        outer.executeWithoutResult(status -> {
            assertThat(jdbc.queryForObject("SELECT revoked_at IS NULL FROM auth_authorization_session WHERE id = ?",
                    Boolean.class, login.tokens().sessionId())).isTrue();
            assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isPresent();
            try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
                executor.submit(() -> otherNode.revokeAll(login.userId())).get(10, TimeUnit.SECONDS);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
            // The outer transaction still sees its own historical snapshot.
            assertThat(jdbc.queryForObject("SELECT revoked_at IS NULL FROM auth_authorization_session WHERE id = ?",
                    Boolean.class, login.tokens().sessionId())).isTrue();
            assertThat(service.resolveAccessForAuth(login.tokens().accessToken())).isEmpty();
            assertThat(service.resolveBrowserAuthentication(login.authentication().cookieSecret())).isEmpty();
        });
    }

    private String attempt(SessionService node, Login login) {
        try {
            node.rotate(login.client().clientId(), login.tokens().refreshToken(), Set.of());
            return "SUCCESS";
        } catch (SessionService.SessionRejectedException rejected) {
            return rejected.reason().name();
        }
    }

    private SessionService secondNode() throws Exception {
        DataSource dataSource = MySqlTestDataSources.create(databaseUrl(),
                System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"),
                System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
        var factoryBean = new SqlSessionFactoryBean();
        factoryBean.setDataSource(dataSource);
        SqlSessionFactory factory = factoryBean.getObject();
        factory.getConfiguration().setLocalCacheScope(org.apache.ibatis.session.LocalCacheScope.STATEMENT);
        factory.getConfiguration().setCacheEnabled(false);
        factory.getConfiguration().addMapper(SessionMapper.class);
        factory.getConfiguration().addMapper(AuthorizationCodeMapper.class);
        return new SessionService(new SqlSessionTemplate(factory).getMapper(SessionMapper.class),
                new SqlSessionTemplate(factory).getMapper(AuthorizationCodeMapper.class), clock, new DataSourceTransactionManager(dataSource));
    }

    private Login login() {
        String user = user();
        var client = client();
        var root = service.createAuthentication(user, true);
        var tokens = service.issueInitial(service.createGrant(root.authenticationId(), client.clientId(), Set.of("account", "profile")));
        return new Login(user, client, root, tokens);
    }

    private String user() {
        String user = id();
        accounts.insertUser(user, "Session test");
        return user;
    }

    private Client client() {
        String application = id();
        String client = "test-" + id();
        jdbc.update("INSERT INTO auth_application(id, name, status) VALUES (?, 'Test', 'ACTIVE')", application);
        jdbc.update("""
                INSERT INTO auth_login_client(id, client_id, application_id, client_type, status, allowed_scopes)
                VALUES (?, ?, ?, 'WEB', 'ACTIVE', 'account profile')
                """, id(), client, application);
        return new Client(application, client);
    }

    private int tokenCount(String session) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM auth_user_token WHERE session_id = ?", Integer.class, session);
    }

    private static void rejects(SessionService.Reason reason, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action).isInstanceOfSatisfying(SessionService.SessionRejectedException.class,
                failure -> assertThat(failure.reason()).isEqualTo(reason));
    }

    private static String databaseUrl() {
        String url = System.getProperty("auth.it.jdbc-url", "");
        if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?")) {
            throw new IllegalArgumentException("A local disposable auth_test_* database is required");
        }
        return url;
    }

    private static String id() { return UUID.randomUUID().toString(); }
    private record Client(String applicationId, String clientId) {}
    private record Login(String userId, Client client, SessionService.AuthenticationCreated authentication, SessionService.TokenPair tokens) {}

    @TestConfiguration(proxyBeanMethods = false)
    static class ClockConfig {
        @Bean @Primary MutableClock testClock() { return new MutableClock(); }
    }

    static class MutableClock extends Clock {
        volatile Instant current = START;
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) {
            if (!ZoneOffset.UTC.equals(zone)) throw new IllegalArgumentException("UTC test clock only");
            return this;
        }
        @Override public Instant instant() { return current; }
    }
}
