package ai.molis.auth.oauth;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.security.Pkce;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Real embedded HTTP server + real MySQL + production Spring filters/providers.
 * Only the earlier identity-verification step is seeded using trusted internal methods.
 */
@SpringBootTest(classes = AuthApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "auth.issuer=http://localhost:8080")
class TokenEndpointIT {
    @org.springframework.test.context.bean.override.mockito.MockitoBean ai.molis.auth.verification.RedisRateLimiter limiter;
    private static final String REDIRECT = "https://product.example/callback";
    private static final String VERIFIER = "abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDEFGHIJK";
    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5)).build();
    @Value("${local.server.port}") int port;
    @Autowired SessionService sessions;
    @Autowired AuthorizationCodeMapper codes;
    @Autowired AccountMapper accounts;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean SessionMapper mapper;
    @MockitoSpyBean ClientRegistryMapper clients;

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> {
            String url = System.getProperty("auth.it.jdbc-url", "");
            if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?")) {
                throw new IllegalArgumentException("A local disposable auth_test_* database is required");
            }
            return url;
        });
        properties.add("spring.datasource.username", () -> System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"));
        properties.add("spring.datasource.password", () -> System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
    }

    @AfterAll static void closeClient() { HTTP.close(); }

    @Test
    void databaseCurrentTimeAndJavaInstantAgree() {
        var databaseNow = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class).toInstant();
        assertThat(Duration.between(databaseNow, java.time.Instant.now()).abs()).isLessThan(Duration.ofSeconds(5));
        assertThat(jdbc.queryForObject("SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), CURRENT_TIMESTAMP())",
                Integer.class)).isZero();
    }

    @Test
    void codeExchangeUsesRealHttpAndPersistsOnlyHashes() throws Exception {
        var fixture = fixture();
        var response = exchange(fixture, VERIFIER, REDIRECT, fixture.clientId());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Cache-Control")).get().asString().contains("no-store");
        assertThat(response.headers().allValues("Set-Cookie")).isEmpty();
        var json = json(response);
        assertThat(json.get("token_type").asText()).isEqualTo("Bearer");
        assertThat(json.get("access_token").asText()).matches("[A-Za-z0-9_-]{43}");
        assertThat(json.get("refresh_token").asText()).matches("[A-Za-z0-9_-]{43}");
        assertThat(json.get("expires_in").asInt()).isBetween(890, 900);
        assertThat(json.has("id_token")).isFalse();
        assertThat(codes.find(TokenSecrets.digest(fixture.code().code())).consumedAt()).isNotNull();
        assertThat(jdbc.queryForList("SELECT token_hash FROM auth_user_token WHERE session_id = ?",
                String.class, fixture.code().sessionId())).containsExactlyInAnyOrder(
                TokenSecrets.digest(json.get("access_token").asText()), TokenSecrets.digest(json.get("refresh_token").asText()));
        assertThat(sessions.resolveAccessForApplication(json.get("access_token").asText(), fixture.applicationId())).isPresent();
    }

    @Test
    void wrongPkceRedirectOrClientCannotConsumeCode() throws Exception {
        var fixture = fixture();
        var other = fixture();
        error(exchange(fixture, "x".repeat(43), REDIRECT, fixture.clientId()), "invalid_grant");
        error(exchange(fixture, VERIFIER, REDIRECT + "/", fixture.clientId()), "invalid_grant");
        error(exchange(fixture, VERIFIER, REDIRECT, other.clientId()), "invalid_grant");
        assertThat(codes.find(TokenSecrets.digest(fixture.code().code())).consumedAt()).isNull();
        assertThat(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()).statusCode()).isEqualTo(200);
    }

    @Test
    void paddedClientAndRedirectNeverAliasRegisteredValues() throws Exception {
        var fixture = fixture();
        error(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId() + " "), "invalid_client");
        error(exchange(fixture, VERIFIER, REDIRECT + " ", fixture.clientId()), "invalid_grant");
        assertThatThrownBy(() -> sessions.createAuthorizationCode(fixture.authenticationId(), fixture.clientId() + " ",
                id(), REDIRECT, Pkce.challenge(VERIFIER), Set.of("account")))
                .isInstanceOf(SessionService.SessionRejectedException.class);
        assertThatThrownBy(() -> sessions.createAuthorizationCode(fixture.authenticationId(), fixture.clientId(),
                id(), REDIRECT + " ", Pkce.challenge(VERIFIER), Set.of("account")))
                .isInstanceOf(SessionService.SessionRejectedException.class);
        assertThat(codes.find(TokenSecrets.digest(fixture.code().code())).consumedAt()).isNull();
        var issued = json(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()));
        error(refresh(fixture.clientId() + " ", issued.get("refresh_token").asText(), ""), "invalid_client");
        assertThat(sessions.resolveAccessForAuth(issued.get("access_token").asText())).isPresent();
    }

    @Test
    void missingVerifierAndUnknownCodeHaveProtocolErrors() throws Exception {
        var fixture = fixture();
        var params = codeParameters(fixture, VERIFIER, REDIRECT, fixture.clientId());
        params.remove("code_verifier");
        var missing = post(params);
        assertThat(missing.statusCode()).isBetween(400, 499);
        assertThat(json(missing).get("error").asText()).isNotBlank();
        params.put("code_verifier", VERIFIER);
        params.put("code", TokenSecrets.generate());
        error(post(params), "invalid_grant");
    }

    @Test
    void duplicateParametersAndTokenInQueryAreRejected() throws Exception {
        var fixture = fixture();
        String body = form(codeParameters(fixture, VERIFIER, REDIRECT, fixture.clientId()));
        error(rawPost("/oauth2/token", body + "&grant_type=refresh_token", "application/x-www-form-urlencoded"), "invalid_request");
        error(rawPost("/oauth2/token?code=not-a-real-code", body, "application/x-www-form-urlencoded"), "invalid_request");
        error(rawPost("/oauth2/token", "{}", "application/json"), "invalid_request");
        assertThat(codes.find(TokenSecrets.digest(fixture.code().code())).consumedAt()).isNull();
    }

    @Test
    void expiredCodeAndRemovedRedirectAreRejected() throws Exception {
        var expired = fixture();
        jdbc.update("""
                UPDATE auth_authorization_code SET issued_at = CURRENT_TIMESTAMP(6) - INTERVAL 120 SECOND,
                    expires_at = CURRENT_TIMESTAMP(6) - INTERVAL 60 SECOND WHERE code_hash = ?
                """, TokenSecrets.digest(expired.code().code()));
        error(exchange(expired, VERIFIER, REDIRECT, expired.clientId()), "invalid_grant");
        var removed = fixture();
        jdbc.update("DELETE FROM auth_login_redirect WHERE client_id = ?", removed.registeredClientId());
        var result = exchange(removed, VERIFIER, REDIRECT, removed.clientId());
        assertThat(result.statusCode()).isBetween(400, 499);
        assertThat(json(result).get("error").asText()).isNotBlank();
    }

    @Test
    void codeReplayRevokesTokensEvenAfterRefreshRotation() throws Exception {
        var fixture = fixture();
        var first = json(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()));
        var next = refresh(fixture.clientId(), first.get("refresh_token").asText(), "");
        assertThat(next.statusCode()).isEqualTo(200);
        String currentAccess = json(next).get("access_token").asText();
        error(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()), "invalid_grant");
        assertThat(sessions.resolveAccessForAuth(currentAccess)).isEmpty();
        assertThat(sessions.resolveAccessForAuth(first.get("access_token").asText())).isEmpty();
    }

    @Test
    void refreshRotationScopesAndClientBindingWorkOverHttp() throws Exception {
        var fixture = fixture();
        var other = fixture();
        var first = json(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()));
        String refresh = first.get("refresh_token").asText();
        error(refresh(other.clientId(), refresh, ""), "invalid_grant");
        error(refresh(fixture.clientId(), refresh, "admin"), "invalid_scope");
        var rotated = refresh(fixture.clientId(), refresh, "account");
        assertThat(rotated.statusCode()).isEqualTo(200);
        var next = json(rotated);
        assertThat(next.get("refresh_token").asText()).isNotEqualTo(refresh);
        assertThat(next.get("scope").asText()).isEqualTo("account");
        error(refresh(fixture.clientId(), refresh, ""), "invalid_grant");
        assertThat(sessions.resolveAccessForAuth(next.get("access_token").asText())).isEmpty();
    }

    @Test
    void publicClientCannotUseASecretOrClientCredentialsGrant() throws Exception {
        var fixture = fixture();
        var params = codeParameters(fixture, VERIFIER, REDIRECT, fixture.clientId());
        params.put("client_secret", "not-a-client-secret");
        var secretResult = post(params);
        assertThat(secretResult.statusCode()).isBetween(400, 499);
        assertThat(json(secretResult).get("error").asText()).isNotBlank();
        var credentials = post(Map.of("client_id", fixture.clientId(), "grant_type", "client_credentials"));
        assertThat(credentials.statusCode()).isBetween(400, 499);
        assertThat(json(credentials).get("error").asText()).isNotBlank();
    }

    @Test
    void disabledUserCannotExchangePreviouslyIssuedCode() throws Exception {
        var fixture = fixture();
        sessions.disableUser(fixture.userId());
        error(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()), "invalid_grant");
        assertThat(tokenCount(fixture.code().sessionId())).isZero();
    }

    @Test
    void failedTokenInsertionRollsBackCodeConsumptionAndReturnsUnavailable() throws Exception {
        var fixture = fixture();
        doThrow(new DataAccessResourceFailureException("test-only failure")).when(mapper)
                .insertToken(anyString(), anyString(), eq("REFRESH"), anyString(), any(), any());
        var failed = exchange(fixture, VERIFIER, REDIRECT, fixture.clientId());
        assertThat(failed.statusCode()).isEqualTo(503);
        assertThat(json(failed).get("error").asText()).isEqualTo("temporarily_unavailable");
        assertThat(codes.find(TokenSecrets.digest(fixture.code().code())).consumedAt()).isNull();
        assertThat(tokenCount(fixture.code().sessionId())).isZero();
        assertThat(mapper.findGrant(fixture.code().sessionId()).issuedAt()).isNull();
        reset(mapper);
        assertThat(exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()).statusCode()).isEqualTo(200);
    }

    @Test
    void clientRegistryFailureReturnsUnavailableInsteadOfForbidden() throws Exception {
        var fixture = fixture();
        doThrow(new DataAccessResourceFailureException("test-only failure")).when(clients).findByClientId(fixture.clientId());
        var failed = exchange(fixture, VERIFIER, REDIRECT, fixture.clientId());
        assertThat(failed.statusCode()).isEqualTo(503);
        assertThat(json(failed).get("error").asText()).isEqualTo("temporarily_unavailable");
        assertThat(failed.body()).doesNotContain("test-only");
    }

    @RepeatedTest(5)
    void simultaneousHttpCodeExchangesIssueOnlyOnePair() throws Exception {
        var fixture = fixture();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> { start.await(); return exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()); });
            var second = executor.submit(() -> { start.await(); return exchange(fixture, VERIFIER, REDIRECT, fixture.clientId()); });
            start.countDown();
            assertThat(List.of(first.get(15, TimeUnit.SECONDS).statusCode(), second.get(15, TimeUnit.SECONDS).statusCode()))
                    .containsExactlyInAnyOrder(200, 400);
        }
        assertThat(tokenCount(fixture.code().sessionId())).isEqualTo(2);
        assertThat(mapper.findGrant(fixture.code().sessionId()).revokedAt()).isNotNull();
    }

    @Test
    void oneAuthenticationTransactionCannotCreateTwoCodes() {
        var fixture = fixture();
        String transaction = codes.find(TokenSecrets.digest(fixture.code().code())).authenticationTransactionId();
        int before = jdbc.queryForObject("SELECT COUNT(*) FROM auth_authorization_session WHERE authentication_id = ?",
                Integer.class, fixture.authenticationId());
        assertThatThrownBy(() -> sessions.createAuthorizationCode(fixture.authenticationId(), fixture.clientId(),
                transaction, REDIRECT, Pkce.challenge(VERIFIER), Set.of("account")))
                .isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authorization_session WHERE authentication_id = ?",
                Integer.class, fixture.authenticationId())).isEqualTo(before);
    }

    private Fixture fixture() {
        String user = id(), application = id(), registeredClient = id(), client = "web-" + id();
        accounts.insertUser(user, "Protocol test");
        jdbc.update("INSERT INTO auth_application(id, name, status) VALUES (?, 'HTTP Test', 'ACTIVE')", application);
        jdbc.update("""
                INSERT INTO auth_login_client(id, client_id, application_id, client_type, status, allowed_scopes)
                VALUES (?, ?, ?, 'WEB', 'ACTIVE', 'account')
                """, registeredClient, client, application);
        jdbc.update("INSERT INTO auth_login_redirect(client_id, redirect_uri) VALUES (?, ?)", registeredClient, REDIRECT);
        var root = sessions.createAuthentication(user, true);
        var code = sessions.createAuthorizationCode(root.authenticationId(), client, id(), REDIRECT,
                Pkce.challenge(VERIFIER), Set.of("account"));
        return new Fixture(user, application, registeredClient, client, root.authenticationId(), code);
    }

    private HttpResponse<String> exchange(Fixture fixture, String verifier, String redirect, String client) throws Exception {
        return post(codeParameters(fixture, verifier, redirect, client));
    }

    private Map<String, String> codeParameters(Fixture fixture, String verifier, String redirect, String client) {
        var values = new LinkedHashMap<String, String>();
        values.put("grant_type", "authorization_code");
        values.put("client_id", client);
        values.put("code", fixture.code().code());
        values.put("redirect_uri", redirect);
        values.put("code_verifier", verifier);
        return values;
    }

    private HttpResponse<String> refresh(String client, String token, String scope) throws Exception {
        var values = new LinkedHashMap<>(Map.of("grant_type", "refresh_token", "client_id", client, "refresh_token", token));
        if (!scope.isBlank()) values.put("scope", scope);
        return post(values);
    }

    private HttpResponse<String> post(Map<String, String> values) throws Exception {
        return rawPost("/oauth2/token", form(values), "application/x-www-form-urlencoded");
    }

    private HttpResponse<String> rawPost(String path, String body, String contentType) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10)).header("Content-Type", contentType)
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String form(Map<String, String> values) {
        return values.entrySet().stream().map(entry -> URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8)
                + "=" + URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8)).collect(Collectors.joining("&"));
    }

    private static JsonNode json(HttpResponse<String> response) { return JsonMapper.builder().build().readTree(response.body()); }
    private static void error(HttpResponse<String> response, String code) {
        assertThat(response.statusCode()).isBetween(400, 499);
        assertThat(json(response).get("error").asText()).isEqualTo(code);
    }
    private int tokenCount(String session) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM auth_user_token WHERE session_id = ?", Integer.class, session);
    }
    private static String id() { return UUID.randomUUID().toString(); }
    private record Fixture(String userId, String applicationId, String registeredClientId, String clientId,
                           String authenticationId, SessionService.AuthorizationCodeCreated code) {}
}
