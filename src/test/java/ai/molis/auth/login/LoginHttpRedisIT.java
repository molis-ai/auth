package ai.molis.auth.login;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.security.Pkce;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.AuthorizationCodeMapper;
import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.net.URLEncoder;
import java.net.URLDecoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real HTTP password verification -> Redis transaction -> MySQL code/cookie -> OAuth token endpoint. */
@SpringBootTest(classes = AuthApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"auth.login.enabled=true", "auth.ephemeral.enabled=true", "auth.issuer=http://localhost:8080"})
class LoginHttpRedisIT {
    private static final String AUTH = "http://localhost:8080", PRODUCT = "https://product.example.test";
    private static final String PASSWORD = "HTTP login test password phrase", VERIFIER = "v".repeat(43);
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final JsonMapper JSON = JsonMapper.builder().build();
    @Value("${local.server.port}") int port;
    @Autowired LocalAccountService accounts;
    @Autowired SessionService sessions;
    @Autowired RedisAuthTransactions transactions;
    @Autowired StringRedisTemplate redis;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean AuthorizationCodeMapper codes;

    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> {
            String url = System.getProperty("auth.it.jdbc-url", "");
            if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?")) throw new IllegalArgumentException("Disposable local auth_test_* database required");
            return url;
        });
        properties.add("spring.datasource.username", () -> System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"));
        properties.add("spring.datasource.password", () -> System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
        properties.add("spring.data.redis.host", () -> "127.0.0.1");
        properties.add("spring.data.redis.port", () -> {
            int number = Integer.parseInt(System.getProperty("auth.it.redis-port", "0"));
            if (number < 1024 || number > 65535 || number == 6379) throw new IllegalArgumentException("Dedicated Redis port required");
            return number;
        });
        properties.add("spring.data.redis.username", () -> ""); properties.add("spring.data.redis.password", () -> "");
        properties.add("spring.data.redis.ssl.enabled", () -> false);
    }
    @AfterAll static void close() { HTTP.close(); }

    @Test void signupDoesNotDependOnMailConfiguration() throws Exception {
        var f=fixture("WEB"); String transaction=begin(f,false),email=UUID.randomUUID()+"@example.test";
        var response=post("/signup",Map.of("email",email,"password",PASSWORD,"confirmPassword",PASSWORD),transaction,AUTH,null);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        assertThat(post("/complete",Map.of(),transaction,AUTH,null).statusCode()).isEqualTo(200);
        assertThat(post("/password",Map.of("email",email,"password",PASSWORD),begin(f,false),AUTH,null).statusCode()).isEqualTo(200);
    }

    @Test void authPagesHaveSecurityHeadersAndOnlyExposeEnabledCapabilities() throws Exception {
        boolean packaged = new org.springframework.core.io.ClassPathResource("static/auth-ui/index.html").exists();
        for (String path : List.of("/login", "/provider", "/register", "/forgot-password", "/complete", "/verify-email")) {
            var response = HTTP.send(HttpRequest.newBuilder(uri(path)).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(packaged ? 200 : 503);
            assertThat(response.headers().firstValue("Content-Security-Policy").orElseThrow()).contains("script-src 'self'", "frame-ancestors 'none'").doesNotContain("unsafe-eval");
            assertThat(response.headers().firstValue("Referrer-Policy")).contains("no-referrer");
            assertThat(response.headers().firstValue("Cache-Control").orElseThrow()).contains("no-store");
            if (packaged) {
                var script = java.util.regex.Pattern.compile("src=\"(/auth-ui/assets/[^\"]+\\.js)\"").matcher(response.body());
                assertThat(script.find()).isTrue();
                var asset = HTTP.send(HttpRequest.newBuilder(uri(script.group(1))).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(asset.statusCode()).isEqualTo(200);
            }
        }
        var config = HTTP.send(HttpRequest.newBuilder(uri("/api/v1/auth/ui-configuration")).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(config.statusCode()).isEqualTo(200);
        assertThat(json(config).path("data").path("mailboxEnabled").asBoolean()).isFalse();
        assertThat(json(config).path("data").path("authOrigin").asText()).isEqualTo(AUTH);
        assertThat(json(config).path("data").path("providers").isArray()).isTrue();
        assertThat(json(config).path("data").path("providers").size()).isZero();
    }

    @Test void passwordLoginHandoffAndTokenExchangeWorkWithoutPreseededCodes() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        assertThat(redis.opsForHash().entries(key(transaction)).toString()).doesNotContain(transaction, PASSWORD);
        var password = password(f, transaction, PASSWORD);
        assertThat(password.statusCode()).isEqualTo(200);
        assertThat(password.headers().allValues("Set-Cookie")).isEmpty();
        assertThat(json(password).get("data").get("continueUrl").asText()).startsWith(AUTH + "/complete#transaction=");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ? AND cookie_hash IS NOT NULL", Integer.class, f.user())).isZero();
        var complete = post("/complete", Map.of(), transaction, AUTH, null);
        assertThat(complete.statusCode()).isEqualTo(200);
        String cookie = complete.headers().firstValue("Set-Cookie").orElseThrow();
        assertThat(cookie).contains("HttpOnly", "SameSite=Lax").doesNotContain("Domain=");
        String code = code(complete);
        var tokenResponse = exchange(f, code, VERIFIER);
        assertThat(tokenResponse.statusCode()).isEqualTo(200);
        assertThat(tokenResponse.headers().firstValue("Access-Control-Allow-Origin")).contains(PRODUCT);
        assertThat(sessions.resolveAccessForApplication(json(tokenResponse).get("access_token").asText(), f.application())).isPresent();
        assertThat(complete.body()).doesNotContain(cookie.split(";", 2)[0].split("=", 2)[1]);
    }

    @Test void completionBeforeLoginAndFromProductOriginIsRejected() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        assertThat(post("/complete", Map.of(), transaction, AUTH, null).statusCode()).isEqualTo(400);
        assertThat(password(f, transaction, PASSWORD).statusCode()).isEqualTo(200);
        assertThat(post("/complete", Map.of(), transaction, PRODUCT, null).statusCode()).isEqualTo(403);
        assertThat(post("/complete", Map.of(), transaction, AUTH, null).statusCode()).isEqualTo(200);
    }

    @Test void wrongPasswordsCannotCreateRootAndFiveFailuresCloseTransaction() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        for (int i = 0; i < 5; i++) {
            var response = password(f, transaction, "incorrect test password");
            assertThat(response.statusCode()).isEqualTo(401);
            assertThat(json(response).get("error").get("code").asText()).isEqualTo("INVALID_CREDENTIALS");
        }
        assertThat(password(f, transaction, PASSWORD).statusCode()).isEqualTo(400);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ?", Integer.class, f.user())).isZero();
    }

    @Test void webRestoreKeepsOriginalRootAndNativeClientsRequireFullLogin() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        password(f, transaction, PASSWORD);
        var completed = post("/complete", Map.of(), transaction, AUTH, null);
        String cookie = completed.headers().firstValue("Set-Cookie").orElseThrow().split(";", 2)[0];
        String root = sessions.resolveBrowserAuthentication(cookie.split("=", 2)[1]).orElseThrow();
        var original = jdbc.queryForObject("SELECT authenticated_at FROM auth_authentication_session WHERE id = ?", java.sql.Timestamp.class, root);
        String restored = begin(f, false);
        assertThat(post("/restore", Map.of(), restored, AUTH, cookie).statusCode()).isEqualTo(200);
        var result = post("/complete", Map.of(), restored, AUTH, cookie);
        assertThat(result.statusCode()).isEqualTo(200); assertThat(result.headers().allValues("Set-Cookie")).allMatch(value -> value.startsWith("auth_confirm_dev_") && value.contains("Max-Age=0"));
        assertThat(jdbc.queryForObject("SELECT authenticated_at FROM auth_authentication_session WHERE id = ?", java.sql.Timestamp.class, root)).isEqualTo(original);
        assertThat(post("/restore", Map.of(), begin(f, true), AUTH, cookie).statusCode()).isEqualTo(401);
        var nativeClient = fixture("MACOS"); String nativeTransaction = begin(nativeClient, false);
        assertThat(post("/restore", Map.of(), nativeTransaction, AUTH, cookie).statusCode()).isEqualTo(401);
        assertThat(password(nativeClient, nativeTransaction, PASSWORD).statusCode()).isEqualTo(200);
        var nativeComplete = post("/complete", Map.of(), nativeTransaction, AUTH, null);
        assertThat(nativeComplete.statusCode()).isEqualTo(200); assertThat(nativeComplete.headers().allValues("Set-Cookie")).allMatch(value -> value.startsWith("auth_confirm_dev_") && value.contains("Max-Age=0"));
    }

    @Test void expiredOrDisabledTransactionCannotComplete() throws Exception {
        var f = fixture("WEB"); String expired = begin(f, false);
        redis.expire(key(expired), Duration.ZERO);
        assertThat(password(f, expired, PASSWORD).statusCode()).isEqualTo(400);
        String disabled = begin(f, false); password(f, disabled, PASSWORD); sessions.disableUser(f.user());
        var result = post("/complete", Map.of(), disabled, AUTH, null);
        assertThat(result.statusCode()).isEqualTo(400); assertThat(result.headers().allValues("Set-Cookie")).isEmpty();
    }

    @Test void concurrentCompletionOnlyIssuesOneCodeAndCookie() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false); password(f, transaction, PASSWORD);
        String internalId = transactions.read(transaction).context().id();
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> { start.await(); return post("/complete", Map.of(), transaction, AUTH, null); });
            var b = executor.submit(() -> { start.await(); return post("/complete", Map.of(), transaction, AUTH, null); });
            start.countDown();
            assertThat(List.of(a.get(10, TimeUnit.SECONDS).statusCode(), b.get(10, TimeUnit.SECONDS).statusCode())).containsExactlyInAnyOrder(200, 400);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authorization_code WHERE authentication_transaction_id = ?", Integer.class, internalId)).isEqualTo(1);
    }

    @Test void concurrentPasswordSubmissionCreatesOnlyOneAuthenticationRoot() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        var start = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var a = executor.submit(() -> { start.await(); return password(f, transaction, PASSWORD); });
            var b = executor.submit(() -> { start.await(); return password(f, transaction, PASSWORD); });
            start.countDown();
            assertThat(List.of(a.get(10, TimeUnit.SECONDS).statusCode(), b.get(10, TimeUnit.SECONDS).statusCode()))
                    .containsExactlyInAnyOrder(200, 400);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ?", Integer.class, f.user())).isEqualTo(1);
        assertThat(post("/complete", Map.of(), transaction, AUTH, null).statusCode()).isEqualTo(200);
    }

    @Test void transactionStateChangesNeverExtendOriginalDeadline() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false);
        redis.expire(key(transaction), Duration.ofSeconds(30));
        assertThat(password(f, transaction, "incorrect test password").statusCode()).isEqualTo(401);
        assertThat(redis.getExpire(key(transaction), TimeUnit.MILLISECONDS)).isBetween(1L, 30000L);
        assertThat(password(f, transaction, PASSWORD).statusCode()).isEqualTo(200);
        assertThat(redis.getExpire(key(transaction), TimeUnit.MILLISECONDS)).isBetween(1L, 30000L);
        redis.expire(key(transaction), Duration.ZERO);
        var expired = post("/complete", Map.of(), transaction, AUTH, null);
        assertThat(expired.statusCode()).isEqualTo(400);
        assertThat(expired.headers().allValues("Set-Cookie")).isEmpty();
        String noDeadline = begin(f, false);
        redis.persist(key(noDeadline));
        try { assertThat(password(f, noDeadline, PASSWORD).statusCode()).isEqualTo(400); }
        finally { redis.delete(key(noDeadline)); }
    }

    @Test void codeInsertFailureRollsBackCookieAttachmentAndRequiresNewTransaction() throws Exception {
        var f = fixture("WEB"); String transaction = begin(f, false); password(f, transaction, PASSWORD);
        doThrow(new DataAccessResourceFailureException("private database detail")).when(codes)
                .insert(anyString(), anyString(), anyString(), anyString(), anyString(), any(), any());
        var failed = post("/complete", Map.of(), transaction, AUTH, null);
        assertThat(failed.statusCode()).isEqualTo(503); assertThat(failed.body()).doesNotContain("private database detail");
        assertThat(failed.headers().allValues("Set-Cookie")).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id = ? AND cookie_hash IS NOT NULL", Integer.class, f.user())).isZero();
        assertThat(post("/complete", Map.of(), transaction, AUTH, null).statusCode()).isEqualTo(400);
    }

    @Test void corsPreflightAndClientSpecificOriginAreEnforced() throws Exception {
        var f = fixture("WEB");
        var preflight = HTTP.send(HttpRequest.newBuilder(uri("/oauth2/token")).method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .header("Origin", PRODUCT).header("Access-Control-Request-Method", "POST").header("Access-Control-Request-Headers", "content-type").build(), HttpResponse.BodyHandlers.ofString());
        assertThat(preflight.statusCode()).isEqualTo(204);
        assertThat(preflight.headers().firstValue("Access-Control-Allow-Origin")).contains(PRODUCT);
        assertThat(post("", beginBody(f, false), null, "https://unregistered.example", null).statusCode()).isEqualTo(403);
        var badBody = new LinkedHashMap<>(beginBody(f, false)); badBody.put("redirectUri", f.redirect() + " ");
        assertThat(post("", badBody, null, PRODUCT, null).statusCode()).isEqualTo(400);
        var other = fixture("WEB"); String otherOrigin = "https://other-product.example.test";
        jdbc.update("UPDATE auth_login_redirect SET redirect_uri = ? WHERE client_id = (SELECT id FROM auth_login_client WHERE client_id = ?)",
                otherOrigin + "/callback", other.client());
        String transaction = begin(f, false);
        var mixed = post("/password", Map.of("email", f.email(), "password", PASSWORD), transaction, otherOrigin, null);
        assertThat(mixed.statusCode()).isEqualTo(403);
        assertThat(json(mixed).get("error").get("code").asText()).isEqualTo("ORIGIN_NOT_ALLOWED");
        assertThat(transactions.read(transaction).status()).isEqualTo("READY");
        assertThat(password(f, transaction, PASSWORD).statusCode()).isEqualTo(200);
    }

    private Fixture fixture(String type) {
        String email = id() + "@example.test", application = id(), client = "login-" + id(), registered = id();
        String user = accounts.registerAfterMailboxVerification(id(), email, "HTTP fixture", PASSWORD, "en", id());
        String redirect = type.equals("WEB") ? PRODUCT + "/callback" : "auth-test://callback";
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Login HTTP test','ACTIVE')", application);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,?,'ACTIVE','account')", registered, client, application, type);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)", registered, redirect);
        return new Fixture(user, email, application, client, redirect, type);
    }
    private String begin(Fixture f, boolean force) throws Exception {
        var response = post("", beginBody(f, force), null, f.type().equals("WEB") ? PRODUCT : null, null);
        assertThat(response.statusCode()).isEqualTo(200);
        return json(response).get("data").get("transaction").asText();
    }
    private Map<String,Object> beginBody(Fixture f, boolean force) {
        return Map.of("clientId", f.client(), "redirectUri", f.redirect(), "codeChallenge", Pkce.challenge(VERIFIER),
                "codeChallengeMethod", "S256", "state", TokenSecrets.generate(), "scopes", List.of("account"), "forceLogin", force);
    }
    private HttpResponse<String> password(Fixture f, String transaction, String password) throws Exception {
        return post("/password", Map.of("email", f.email(), "password", password), transaction, f.type().equals("WEB") ? PRODUCT : null, null);
    }
    private HttpResponse<String> post(String suffix, Object body, String token, String origin, String cookie) throws Exception {
        // Explicit HTTP fixture confirmation; raw guard/replay cases live in CompletionHttpRedisIT.
        if (suffix.equals("/complete")) {
            var preview = post("/confirmation", Map.of(), token, origin, cookie);
            if (preview.statusCode() != 200) return preview;
            String binding = preview.headers().firstValue("Set-Cookie").orElseThrow().split(";", 2)[0];
            cookie = cookie == null ? binding : cookie + "; " + binding;
            body = Map.of("confirmation", json(preview).path("data").path("confirmation").asText(), "confirmed", true);
        }
        var request = HttpRequest.newBuilder(uri("/api/v1/auth/transactions" + suffix)).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        if (token != null) request.header(AuthHttpBoundary.TRANSACTION_HEADER, token);
        if (origin != null) request.header("Origin", origin);
        if (cookie != null) request.header("Cookie", cookie);
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<String> exchange(Fixture f, String code, String verifier) throws Exception {
        String form = Map.of("grant_type", "authorization_code", "client_id", f.client(), "redirect_uri", f.redirect(), "code", code,
                "code_verifier", verifier).entrySet().stream().map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                        + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8)).collect(Collectors.joining("&"));
        return HTTP.send(HttpRequest.newBuilder(uri("/oauth2/token")).header("Content-Type", "application/x-www-form-urlencoded")
                .header("Origin", PRODUCT).POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
    }
    private static String code(HttpResponse<String> completed) {
        String url = json(completed).get("data").get("redirectTo").asText();
        return Arrays.stream(URI.create(url).getRawQuery().split("&")).filter(p -> p.startsWith("code=")).map(p -> URLDecoder.decode(p.substring(5), StandardCharsets.UTF_8)).findFirst().orElseThrow();
    }
    private URI uri(String path) { return URI.create("http://127.0.0.1:" + port + path); }
    private static JsonNode json(HttpResponse<String> response) { return JSON.readTree(response.body()); }
    private static String key(String token) { return "auth:v1:transaction:" + TokenSecrets.digest(token); }
    private static String id() { return UUID.randomUUID().toString(); }
    private record Fixture(String user, String email, String application, String client, String redirect, String type) {}
}
