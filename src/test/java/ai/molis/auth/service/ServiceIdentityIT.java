package ai.molis.auth.service;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
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

@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=false","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080"})
class ServiceIdentityIT {
    @org.springframework.test.context.bean.override.mockito.MockitoBean ai.molis.auth.verification.RedisRateLimiter limiter;
    @Value("${local.server.port}") int port;
    @Autowired ServiceIdentityService services;
    @Autowired SessionService sessions;
    @Autowired LocalAccountService accounts;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean ServiceIdentityMapper mapper;
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    @AfterAll static void close(){HTTP.close();}
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p){
        p.add("spring.datasource.url",()->{
            String url=System.getProperty("auth.it.jdbc-url","");
            if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable local database required");
            return url;
        });
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    @Test void clientCredentialsIssuesShortOpaqueServiceTokenAndAuditsRequest() throws Exception {
        var f=fixture();var response=issue(f.created(),"grant_type=client_credentials");
        assertThat(response.statusCode()).isEqualTo(200);var body=json(response);String token=body.path("access_token").asText();
        assertThat(token).matches("[A-Za-z0-9_-]{43}");assertThat(body.has("refresh_token")).isFalse();
        assertThat(body.path("expires_in").asLong()).isBetween(298L,300L);assertThat(body.path("scope").asText()).isEqualTo("authorization");
        assertThat(response.headers().firstValue("Cache-Control").orElseThrow()).contains("no-store");
        var principal=services.resolve(token).orElseThrow();assertThat(principal.applicationId()).isEqualTo(f.app());
        assertThat(jdbc.queryForObject("SELECT token_hash FROM auth_service_token WHERE credential_id=?",String.class,f.created().credentialId())).isEqualTo(TokenSecrets.digest(token)).isNotEqualTo(token);
        assertThat(jdbc.queryForObject("SELECT secret_hash FROM auth_service_credential WHERE id=?",String.class,f.created().credentialId())).isEqualTo(TokenSecrets.digest(f.created().secret()));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='service.token.issue' AND request_id=? AND target_service_client_id=?",Integer.class,response.headers().firstValue("X-Request-ID").orElseThrow(),f.created().id())).isEqualTo(1);
        assertThat(f.created().toString()).doesNotContain(f.created().secret());
    }
    @Test void serviceAndUserTokensAreNotInterchangeable() throws Exception {
        var f=fixture();String serviceToken=json(issue(f.created(),"grant_type=client_credentials")).path("access_token").asText();
        assertThat(sessions.resolveAccessForApplication(serviceToken,f.app())).isEmpty();
        String user=accounts.registerAfterMailboxVerification(id(),id()+"@example.test","Service boundary fixture","Service user isolation phrase","en",id());
        String registered=id(),client="service-test-web-"+id();
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,f.app());
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,'https://service-fixture.example.test/callback')",registered);
        var root=sessions.createAuthentication(user,false);
        var pair=sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,Set.of("account")));
        assertThat(services.resolve(pair.accessToken())).isEmpty();assertThat(services.resolve(pair.refreshToken())).isEmpty();
        assertThat(post(basic(client,f.created().secret()),"grant_type=client_credentials",null).statusCode()).isEqualTo(401);
        assertThat(post(basic(f.created().clientId(),f.created().secret()),"grant_type=refresh_token&refresh_token="+pair.refreshToken(),null).statusCode()).isEqualTo(401);
    }
    @Test void rotationRevokesOldCredentialAndItsTokensAndBlocksAlreadyAuthenticatedRequest() throws Exception {
        var f=fixture();var old=services.authenticate(f.created().clientId(),f.created().secret());
        String token=json(issue(f.created(),"grant_type=client_credentials")).path("access_token").asText();
        var rotated=services.rotate(f.created().clientId(),f.actor(),id());
        assertThat(services.resolve(token)).isEmpty();
        assertThatThrownBy(()->services.issue(old,Set.of(),id())).isInstanceOf(ServiceIdentityService.Rejected.class);
        assertThat(issue(f.created(),"grant_type=client_credentials").statusCode()).isEqualTo(401);
        assertThat(post(basic(f.created().clientId(),rotated.secret()),"grant_type=client_credentials",null).statusCode()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_service_credential WHERE service_client_id=? AND revoked_at IS NULL",Integer.class,f.created().id())).isEqualTo(1);
    }
    @Test void disabledApplicationOrServiceCannotMintOrUseTokens() throws Exception {
        var f=fixture();String token=json(issue(f.created(),"grant_type=client_credentials")).path("access_token").asText();
        services.disable(f.created().clientId(),f.actor(),id());
        assertThat(services.resolve(token)).isEmpty();assertThat(issue(f.created(),"grant_type=client_credentials").statusCode()).isEqualTo(401);
        var other=fixture();String second=json(issue(other.created(),"grant_type=client_credentials")).path("access_token").asText();
        jdbc.update("UPDATE auth_application SET status='DISABLED' WHERE id=?",other.app());
        assertThat(services.resolve(second)).isEmpty();assertThat(issue(other.created(),"grant_type=client_credentials").statusCode()).isEqualTo(401);
    }
    @Test void deniedAuthenticationIsAuditedWithoutSecretsAndAuditFailureIsUnavailable()throws Exception{
        var f=fixture();String wrong=TokenSecrets.generate();
        var response=post(basic(f.created().clientId(),wrong),"grant_type=client_credentials",null);
        assertThat(response.statusCode()).isEqualTo(401);
        var row=jdbc.queryForMap("SELECT * FROM auth_audit_event WHERE request_id=?",response.headers().firstValue("X-Request-ID").orElseThrow());
        assertThat(row.get("action")).isEqualTo("service.authentication");assertThat(row.get("outcome")).isEqualTo("DENIED");
        assertThat(row.toString()).doesNotContain(wrong,f.created().secret(),f.created().clientId());
        doThrow(new DataAccessResourceFailureException("private denial audit failure")).when(mapper).authenticationDenied(anyString(),anyString(),any(),anyString());
        assertThat(post(basic(f.created().clientId(),wrong),"grant_type=client_credentials",null).statusCode()).isEqualTo(503);
        assertThat(tokenCount(f)).isZero();
    }
    @Test void serviceIssuanceLimitsAndRedisOutageNeverCreateTokens()throws Exception{
        var f=fixture();
        doThrow(new ai.molis.auth.verification.EphemeralFailure(ai.molis.auth.verification.EphemeralFailure.Reason.RATE_LIMITED,12))
                .when(limiter).acquire(eq(ai.molis.auth.verification.RedisRateLimiter.Bucket.SERVICE_TOKEN_CLIENT),anyString());
        var limited=issue(f.created(),"grant_type=client_credentials");assertThat(limited.statusCode()).isEqualTo(429);
        assertThat(limited.headers().firstValue("Retry-After")).isPresent();assertThat(tokenCount(f)).isZero();
        reset(limiter);
        doThrow(new ai.molis.auth.verification.EphemeralFailure(ai.molis.auth.verification.EphemeralFailure.Reason.UNAVAILABLE))
                .when(limiter).acquire(eq(ai.molis.auth.verification.RedisRateLimiter.Bucket.SERVICE_TOKEN_IP),anyString());
        assertThat(issue(f.created(),"grant_type=client_credentials").statusCode()).isEqualTo(503);assertThat(tokenCount(f)).isZero();
    }
    @Test void scopeEscalationBrowserOriginAndMixedCredentialsAreRejected() throws Exception {
        var f=fixture();String basic=basic(f.created().clientId(),f.created().secret());
        var scope=post(basic,"grant_type=client_credentials&scope=account",null);
        assertThat(scope.statusCode()).isEqualTo(400);assertThat(json(scope).path("error").asText()).isEqualTo("invalid_scope");
        assertThat(post(basic,"grant_type=client_credentials","https://product.example.test").statusCode()).isEqualTo(401);
        assertThat(post(basic,"grant_type=client_credentials&client_id="+f.created().clientId(),null).statusCode()).isEqualTo(401);
        assertThat(post(null,"grant_type=client_credentials&client_id="+f.created().clientId()+"&client_secret="+f.created().secret(),null).statusCode()).isEqualTo(401);
        var duplicate=HttpRequest.newBuilder(uri()).header("Content-Type","application/x-www-form-urlencoded").header("Authorization",basic).header("Authorization",basic)
                .POST(HttpRequest.BodyPublishers.ofString("grant_type=client_credentials")).build();
        assertThat(HTTP.send(duplicate,HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
        assertThat(tokenCount(f)).isZero();
    }
    @Test void auditFailureRollsBackTokenIssuanceAndCredentialRotation() throws Exception {
        var f=fixture();
        doThrow(new DataAccessResourceFailureException("private service audit detail")).when(mapper).audit(anyString(),eq("service.token.issue"),isNull(),anyString(),any(),eq(f.app()),eq(f.created().id()),anyString());
        var response=issue(f.created(),"grant_type=client_credentials");assertThat(response.statusCode()).isEqualTo(503);
        assertThat(response.body()).doesNotContain("private service audit detail",f.created().secret());assertThat(tokenCount(f)).isZero();
        doThrow(new DataAccessResourceFailureException("private rotation detail")).when(mapper).audit(anyString(),eq("service.credential.rotate"),eq(f.actor()),anyString(),any(),eq(f.app()),eq(f.created().id()),anyString());
        assertThatThrownBy(()->services.rotate(f.created().clientId(),f.actor(),id())).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(services.authenticate(f.created().clientId(),f.created().secret()).credentialId()).isEqualTo(f.created().credentialId());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_service_credential WHERE service_client_id=?",Integer.class,f.created().id())).isEqualTo(1);
    }
    @Test void expiredServiceTokenAndAmbiguousClientIdentifierFailClosed() throws Exception {
        var f=fixture();String token=json(issue(f.created(),"grant_type=client_credentials")).path("access_token").asText();
        jdbc.update("UPDATE auth_service_token SET issued_at=UTC_TIMESTAMP(6)-INTERVAL 2 SECOND,expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE credential_id=?",f.created().credentialId());
        assertThat(services.resolve(token)).isEmpty();
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(?,?,?,'WEB','ACTIVE','account')",id(),f.created().clientId(),f.app());
        assertThat(issue(f.created(),"grant_type=client_credentials").statusCode()).isEqualTo(401);
    }
    @Test void concurrentIssueAndDisableNeverLeaveUsableServiceToken() throws Exception {
        var f=fixture();var start=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var issuing=executor.submit(()->{start.await();return issue(f.created(),"grant_type=client_credentials");});
            var disabling=executor.submit(()->{start.await();services.disable(f.created().clientId(),f.actor(),id());return true;});
            start.countDown();var response=issuing.get(15,TimeUnit.SECONDS);assertThat(disabling.get(15,TimeUnit.SECONDS)).isTrue();
            assertThat(response.statusCode()).isIn(200,401);
            if(response.statusCode()==200)assertThat(services.resolve(json(response).path("access_token").asText())).isEmpty();
            assertThat(issue(f.created(),"grant_type=client_credentials").statusCode()).isEqualTo(401);
        }
    }
    @Test void unavailableIdentityStoreDoesNotBecomeInvalidCredentialsOrAnonymousAccess() throws Exception {
        var f=fixture();doThrow(new DataAccessResourceFailureException("private credentials table")).when(mapper).findClient(f.created().clientId());
        var response=issue(f.created(),"grant_type=client_credentials");
        assertThat(response.statusCode()).isEqualTo(503);assertThat(json(response).path("error").asText()).isEqualTo("temporarily_unavailable");
        assertThat(response.body()).doesNotContain("private credentials table");
    }
    private Fixture fixture(){String app=id(),actor=id();jdbc.update("INSERT INTO auth_application(id,name,status) VALUES(?,'Service identity test','ACTIVE')",app);return new Fixture(app,actor,services.create(app,"Test backend",actor,id()));}
    private int tokenCount(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM auth_service_token t JOIN auth_service_credential c ON c.id=t.credential_id WHERE c.service_client_id=?",Integer.class,f.created().id());}
    private HttpResponse<String> issue(ServiceIdentityService.Created c,String body)throws Exception{return post(basic(c.clientId(),c.secret()),body,null);}
    private HttpResponse<String> post(String authorization,String body,String origin)throws Exception{
        var request=HttpRequest.newBuilder(uri()).timeout(Duration.ofSeconds(10)).header("Content-Type","application/x-www-form-urlencoded");
        if(authorization!=null)request.header("Authorization",authorization);if(origin!=null)request.header("Origin",origin);
        return HTTP.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
    }
    private URI uri(){return URI.create("http://127.0.0.1:"+port+"/oauth2/token");}
    private static String basic(String id,String secret){return "Basic "+Base64.getEncoder().encodeToString((id+":"+secret).getBytes(StandardCharsets.UTF_8));}
    private static JsonNode json(HttpResponse<String> response){return JsonMapper.builder().build().readTree(response.body());}
    private static String id(){return UUID.randomUUID().toString();}
    private record Fixture(String app,String actor,ServiceIdentityService.Created created){}
}
