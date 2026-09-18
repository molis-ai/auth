package ai.molis.auth.login;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.*;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real HTTP/MySQL self-account API. Identity is preverified by fixtures; unrelated login limiter is unused. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080"})
class SelfAccountIT {
    private static final String A="https://self-a.example.test",B="https://self-b.example.test";
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired LocalAccountService accounts;
    @Autowired SessionService sessions;
    @MockitoBean RedisRateLimiter unusedLoginLimiter;
    @MockitoSpyBean SelfSessionMapper audit;
    @MockitoSpyBean SelfSecurityMapper security;
    @MockitoSpyBean SessionMapper mapper;
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{
            String url=System.getProperty("auth.it.jdbc-url","");
            if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable local auth_test_* database required");
            return url;
        });
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    @AfterAll static void close(){HTTP.close();}
    @AfterEach void unrelatedLoginLimiterNotUsed(){verifyNoInteractions(unusedLoginLimiter);}

    @Test void readsOnlyAuthenticatedAccountAndRequiresAccountScope() throws Exception {
        var f=fixture(A,Set.of("account"));
        var response=get(f.tokens().accessToken(),A);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(json(response).path("data").path("userId").asText()).isEqualTo(f.user());
        assertThat(json(response).path("data").path("emails").get(0).asText()).isEqualTo(f.email());
        assertThat(response.body()).doesNotContain(f.tokens().accessToken(),f.tokens().refreshToken(),f.root().cookieSecret(),"authenticationId");
        var restricted=fixture(A,Set.of("profile"));
        var denied=get(restricted.tokens().accessToken(),A);
        assertThat(denied.statusCode()).isEqualTo(403);
        assertThat(denied.headers().firstValue("WWW-Authenticate").orElseThrow()).contains("insufficient_scope");
    }

    @Test void currentLogoutKeepsOtherApplicationAndBrowserRootButRevokesOwnTokens() throws Exception {
        var f=fixture(A,Set.of("account")); var other=grant(f.user(),f.email(),f.root(),B,Set.of("account"));
        var response=post("/current/logout",f.tokens().accessToken(),A,Map.of());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(401);
        assertThat(get(other.tokens().accessToken(),B).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isPresent();
        assertThatThrownBy(()->sessions.rotate(f.client(),f.tokens().refreshToken(),Set.of())).isInstanceOf(SessionService.SessionRejectedException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='session.logout.current' AND request_id=? AND application_id=? AND authorization_session_id=?",Integer.class,
                response.headers().firstValue("X-Request-ID").orElseThrow(),f.app(),f.tokens().sessionId())).isEqualTo(1);
    }

    @Test void allLogoutRevokesOtherDevicesAndApplicationsButNotOtherUsers() throws Exception {
        var f=fixture(A,Set.of("account"));
        var otherDevice=sessions.createAuthentication(f.user(),true);
        var second=grant(f.user(),f.email(),otherDevice,B,Set.of("account"));
        var unrelated=fixture(B,Set.of("account"));
        assertThat(post("/logout-all",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(200);
        assertThat(get(second.tokens().accessToken(),B).statusCode()).isEqualTo(401);
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isEmpty();
        assertThat(sessions.resolveBrowserAuthentication(otherDevice.cookieSecret())).isEmpty();
        assertThat(get(unrelated.tokens().accessToken(),B).statusCode()).isEqualTo(200);
    }

    @Test void callerCannotSelectAnotherTargetOrMixRegisteredProductOrigins() throws Exception {
        var f=fixture(A,Set.of("account"));var other=fixture(B,Set.of("account"));
        assertThat(post("/current/logout",f.tokens().accessToken(),A,Map.of("userId",other.user(),"sessionId",other.tokens().sessionId())).statusCode()).isEqualTo(400);
        assertThat(get(f.tokens().accessToken(),B).statusCode()).isEqualTo(403);
        assertThat(post("/logout-all",f.tokens().accessToken(),B,Map.of()).statusCode()).isEqualTo(403);
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(200);
        assertThat(get(other.tokens().accessToken(),B).statusCode()).isEqualTo(200);
        var preflight=HTTP.send(HttpRequest.newBuilder(uri("/api/v1/users/me")).method("OPTIONS",HttpRequest.BodyPublishers.noBody())
                .header("Origin",A).header("Access-Control-Request-Method","GET").header("Access-Control-Request-Headers","authorization").build(),HttpResponse.BodyHandlers.ofString());
        assertThat(preflight.statusCode()).isEqualTo(204);
        assertThat(preflight.headers().firstValue("Access-Control-Allow-Headers").orElseThrow()).contains("Authorization");
    }

    @Test void cookieRefreshAndDuplicatedAuthorizationCannotAuthenticateTheApi() throws Exception {
        var f=fixture(A,Set.of("account"));
        assertThat(get(f.tokens().refreshToken(),A).statusCode()).isEqualTo(401);
        var request=HttpRequest.newBuilder(uri("/api/v1/users/me")).GET().header("Origin",A)
                .header("Cookie","auth_session_dev="+f.root().cookieSecret());
        assertThat(HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
        request.header("Authorization","Bearer "+f.tokens().accessToken()).header("Authorization","Bearer "+f.tokens().accessToken());
        assertThat(HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }

    @Test void expiredAccessAndDisabledUserAreRejectedWithoutLogoutMutation() throws Exception {
        var f=fixture(A,Set.of("account"));
        jdbc.update("UPDATE auth_user_token SET issued_at=CURRENT_TIMESTAMP(6)-INTERVAL 2 SECOND, expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE token_hash=?",TokenSecrets.digest(f.tokens().accessToken()));
        assertThat(post("/current/logout",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(401);
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isPresent();
        var disabled=fixture(A,Set.of("account"));sessions.disableUser(disabled.user());
        assertThat(get(disabled.tokens().accessToken(),A).statusCode()).isEqualTo(401);
    }

    @Test void auditFailureRollsBackAllRevocationsAndReturnsUnavailable() throws Exception {
        var f=fixture(A,Set.of("account"));
        doThrow(new DataAccessResourceFailureException("private audit store detail")).when(audit).audit(anyString(),eq("session.logout.all"),eq(f.user()),anyString(),any(),anyString(),anyString());
        var response=post("/logout-all",f.tokens().accessToken(),A,Map.of());
        assertThat(response.statusCode()).isEqualTo(503);assertThat(response.body()).doesNotContain("private audit store detail");
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isPresent();
    }

    @Test void concurrentLogoutCommitsOneAuditAndOtherRequestSeesRevocation() throws Exception {
        var f=fixture(A,Set.of("account"));var start=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var a=executor.submit(()->{start.await();return post("/current/logout",f.tokens().accessToken(),A,Map.of()).statusCode();});
            var b=executor.submit(()->{start.await();return post("/current/logout",f.tokens().accessToken(),A,Map.of()).statusCode();});
            start.countDown();assertThat(List.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,401);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='session.logout.current' AND authorization_session_id=?",Integer.class,f.tokens().sessionId())).isEqualTo(1);
    }

    @Test void disablingAfterCandidateReadCannotLeakStaleIdentity() throws Exception {
        var f=fixture(A,Set.of("account"));String hash=TokenSecrets.digest(f.tokens().accessToken());
        var candidate=mapper.findAccess(hash);var first=new AtomicBoolean(true);
        doAnswer(invocation->{if(first.getAndSet(false))sessions.disableUser(f.user());return candidate;}).when(mapper).findAccess(hash);
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(401);
        verify(audit,never()).displayName(f.user());
    }

    @Test void listsOnlyOwnRootsWithStablePaginationStatusAndNoSecrets() throws Exception {
        var f=fixture(A,Set.of("account"));var unrelated=fixture(A,Set.of("account"));
        var expired=sessions.createAuthentication(f.user(),true);
        var revoked=sessions.createAuthentication(f.user(),true);
        jdbc.update("UPDATE auth_authentication_session SET authenticated_at=CURRENT_TIMESTAMP(6)-INTERVAL 31 DAY,last_user_activity_at=CURRENT_TIMESTAMP(6)-INTERVAL 31 DAY WHERE id=?",expired.authenticationId());
        jdbc.update("UPDATE auth_authentication_session SET revoked_at=CURRENT_TIMESTAMP(6) WHERE id=?",revoked.authenticationId());
        Set<String> seen=new HashSet<>();String cursor=null;
        do {
            var response=page("authentications",f,"?limit=1"+(cursor==null?"":"&cursor="+cursor));
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.headers().firstValue("Cache-Control").orElseThrow()).contains("no-store");
            assertThat(response.body()).doesNotContain(f.tokens().accessToken(),f.tokens().refreshToken(),f.root().cookieSecret(),"cookie_hash",unrelated.root().authenticationId());
            var data=json(response).path("data");var row=data.path("items").get(0);String id=row.path("id").asText();
            assertThat(seen.add(id)).isTrue();
            assertThat(row.path("current").asBoolean()).isEqualTo(id.equals(f.root().authenticationId()));
            assertThat(row.path("status").asText()).isEqualTo(id.equals(expired.authenticationId())?"EXPIRED":id.equals(revoked.authenticationId())?"REVOKED":"ACTIVE");
            if(id.equals(f.root().authenticationId())) assertThat(row.path("applicationSessionCount").asInt()).isEqualTo(1);
            cursor=data.path("nextCursor").isNull()?null:data.path("nextCursor").asText();
        } while(cursor!=null);
        assertThat(seen).containsExactlyInAnyOrder(f.root().authenticationId(),expired.authenticationId(),revoked.authenticationId());
        assertThat(page("authentications",f,"?cursor="+unrelated.root().authenticationId()).statusCode()).isEqualTo(400);
    }

    @Test void targetedRevocationCascadesOnlyWithinOwnedRootAndIsIdempotent() throws Exception {
        var f=fixture(A,Set.of("account"));var root=sessions.createAuthentication(f.user(),true);
        var second=grant(f.user(),f.email(),root,B,Set.of("account"));var third=grant(f.user(),f.email(),root,A,Set.of("account"));
        var unrelated=fixture(B,Set.of("account"));
        var response=post("/authentications/"+root.authenticationId()+"/revoke",f.tokens().accessToken(),A,Map.of());
        assertThat(response.statusCode()).isEqualTo(200);assertThat(json(response).path("data").path("current").asBoolean()).isFalse();
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(200);
        assertThat(get(second.tokens().accessToken(),B).statusCode()).isEqualTo(401);
        assertThat(get(third.tokens().accessToken(),A).statusCode()).isEqualTo(401);
        assertThat(sessions.resolveBrowserAuthentication(root.cookieSecret())).isEmpty();
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isPresent();
        assertThat(get(unrelated.tokens().accessToken(),B).statusCode()).isEqualTo(200);
        assertThatThrownBy(()->sessions.rotate(second.client(),second.tokens().refreshToken(),Set.of())).isInstanceOf(SessionService.SessionRejectedException.class);
        assertThat(post("/authentications/"+root.authenticationId()+"/revoke",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='session.authentication.revoke' AND authentication_session_id=?",Integer.class,root.authenticationId())).isEqualTo(1);
    }

    @Test void revokingCurrentRootAlsoInvalidatesItsBrowserRestoreAndOtherApplications() throws Exception {
        var f=fixture(A,Set.of("account"));var other=grant(f.user(),f.email(),f.root(),B,Set.of("account"));
        var response=post("/authentications/"+f.root().authenticationId()+"/revoke",f.tokens().accessToken(),A,Map.of());
        assertThat(response.statusCode()).isEqualTo(200);assertThat(json(response).path("data").path("current").asBoolean()).isTrue();
        assertThat(get(f.tokens().accessToken(),A).statusCode()).isEqualTo(401);
        assertThat(get(other.tokens().accessToken(),B).statusCode()).isEqualTo(401);
        assertThat(sessions.resolveBrowserAuthentication(f.root().cookieSecret())).isEmpty();
    }

    @Test void targetedApiRejectsForeignTargetsScopeOriginsAndAmbiguousInput() throws Exception {
        var f=fixture(A,Set.of("account"));var other=fixture(B,Set.of("account"));var limited=fixture(A,Set.of("profile"));
        String target="/authentications/"+other.root().authenticationId()+"/revoke";
        assertThat(post(target,f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(404);
        assertThat(post("/authentications/"+id()+"/revoke",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(404);
        assertThat(post(target,limited.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(403);
        assertThat(post(target,f.tokens().accessToken(),B,Map.of()).statusCode()).isEqualTo(403);
        assertThat(post(target,f.tokens().accessToken(),A,Map.of("userId",other.user())).statusCode()).isEqualTo(400);
        for(String endpoint:List.of("authentications","security-events")) {
            assertThat(page(endpoint,limited,"").statusCode()).isEqualTo(403);
            for(String query:List.of("?limit=0","?limit=201","?limit=hello","?limit=","?limit=1&limit=2","?cursor=bad","?userId="+other.user(),"?cursor="))
                assertThat(page(endpoint,f,query).statusCode()).as(endpoint+query).isEqualTo(400);
            var duplicate=HttpRequest.newBuilder(uri("/api/v1/sessions/"+endpoint)).header("Origin",A).header("Origin",B)
                    .header("Authorization","Bearer "+f.tokens().accessToken()).GET().build();
            assertThat(HTTP.send(duplicate,HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        }
        assertThat(get(other.tokens().accessToken(),B).statusCode()).isEqualTo(200);
    }

    @Test void ownSecurityEventsUseWhitelistAndTargetScopedCursors() throws Exception {
        var f=fixture(A,Set.of("account"));var other=fixture(A,Set.of("account"));
        // Same timestamp forces the ID tie-breaker. Failed login has no authenticated actor.
        String success=id(),denied=id(),platform=id(),space=id(),foreign=id(),foreignActor=id();
        var time=java.sql.Timestamp.from(java.time.Instant.now().plusSeconds(2));
        for(var row:List.of(new String[]{success,"account.login",f.user(),f.user(),"SUCCESS"},new String[]{denied,"account.login",null,f.user(),"DENIED"},
                new String[]{platform,"platform.user.status",f.user(),f.user(),"SUCCESS"},new String[]{space,"space.member.role",f.user(),f.user(),"SUCCESS"},
                new String[]{foreign,"account.login",other.user(),other.user(),"SUCCESS"},new String[]{foreignActor,"account.login",other.user(),f.user(),"SUCCESS"}))
            jdbc.update("INSERT INTO auth_audit_event(id,action,actor_user_id,target_user_id,outcome,request_id,occurred_at) VALUES (?,?,?,?,?,?,?)",row[0],row[1],row[2],row[3],row[4],id(),time);
        Set<String> seen=new HashSet<>();String cursor=null;
        do {
            var response=page("security-events",f,"?limit=1"+(cursor==null?"":"&cursor="+cursor));assertThat(response.statusCode()).isEqualTo(200);
            var data=json(response).path("data");for(var row:data.path("items"))assertThat(seen.add(row.path("id").asText())).isTrue();
            assertThat(response.body()).doesNotContain(other.user(),"actorUserId","targetUserId");
            cursor=data.path("nextCursor").isNull()?null:data.path("nextCursor").asText();
        } while(cursor!=null);
        assertThat(seen).contains(success,denied).doesNotContain(platform,space,foreign,foreignActor).hasSize(3); // plus registration
        for(String invalid:List.of(platform,space,foreign,foreignActor,id()))
            assertThat(page("security-events",f,"?cursor="+invalid).statusCode()).isEqualTo(400);
    }

    @Test void targetedAuditFailureRollsBackRootAndChildren() throws Exception {
        var f=fixture(A,Set.of("account"));var root=sessions.createAuthentication(f.user(),true);
        var second=grant(f.user(),f.email(),root,B,Set.of("account"));
        doThrow(new DataAccessResourceFailureException("sensitive failure")).when(security).auditRevocation(anyString(),eq(f.user()),anyString(),any(),anyString(),anyString(),eq(root.authenticationId()));
        var response=post("/authentications/"+root.authenticationId()+"/revoke",f.tokens().accessToken(),A,Map.of());
        assertThat(response.statusCode()).isEqualTo(503);assertThat(response.body()).doesNotContain("sensitive failure");
        assertThat(get(second.tokens().accessToken(),B).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveBrowserAuthentication(root.cookieSecret())).isPresent();
    }

    @Test void concurrentTargetedRevocationsSerializeAndWriteOnlyOneEvent() throws Exception {
        var f=fixture(A,Set.of("account"));var root=sessions.createAuthentication(f.user(),true);var start=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            Callable<Integer> call=()->{start.await();return post("/authentications/"+root.authenticationId()+"/revoke",f.tokens().accessToken(),A,Map.of()).statusCode();};
            var a=executor.submit(call);var b=executor.submit(call);start.countDown();
            assertThat(List.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS))).containsExactly(200,200);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE authentication_session_id=?",Integer.class,root.authenticationId())).isEqualTo(1);
    }

    @Test void unlinkRequiresRecentIdentityPreservesLastMethodAndRevokesAllSessions()throws Exception{
        var f=fixture(A,Set.of("account"));String external=external(f.user());
        assertThat(page("login-methods",f,"").body()).contains(external,"GOOGLE").doesNotContain("https://accounts.google.com");
        var other=fixture(A,Set.of("account"));
        assertThat(post("/login-methods/"+external+"/unlink",other.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(404);
        jdbc.update("UPDATE auth_authentication_session SET authenticated_at=UTC_TIMESTAMP(6)-INTERVAL 6 MINUTE WHERE id=?",f.root().authenticationId());
        assertThat(post("/login-methods/"+external+"/unlink",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(403);
        jdbc.update("UPDATE auth_authentication_session SET authenticated_at=last_user_activity_at WHERE id=?",f.root().authenticationId());
        jdbc.update("DELETE FROM auth_local_credential WHERE user_id=?",f.user());
        assertThat(post("/login-methods/"+external+"/unlink",f.tokens().accessToken(),A,Map.of()).body()).contains("LAST_LOGIN_METHOD");
        String disabledAlternative=external(f.user());
        assertThat(post("/login-methods/"+external+"/unlink",f.tokens().accessToken(),A,Map.of()).body()).contains("LAST_LOGIN_METHOD");
        jdbc.update("INSERT INTO auth_local_credential(user_id,password_hash) SELECT ?,password_hash FROM auth_local_credential WHERE user_id=?",f.user(),other.user());
        var result=post("/login-methods/"+external+"/unlink",f.tokens().accessToken(),A,Map.of());assertThat(result.statusCode()).isEqualTo(200);
        assertThat(sessions.resolveAccessForAuth(f.tokens().accessToken())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_external_identity WHERE id=?",Integer.class,external)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_external_identity WHERE id=?",Integer.class,disabledAlternative)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id=? AND action='account.external.unlink'",Integer.class,f.user())).isEqualTo(1);
    }
    @Test void unlinkAuditFailureRollsBackIdentityAndRevocation()throws Exception{
        var f=fixture(A,Set.of("account"));String external=external(f.user());
        doThrow(new DataAccessResourceFailureException("private unlink audit")).when(audit).audit(anyString(),eq("account.external.unlink"),anyString(),anyString(),any(),anyString(),anyString());
        assertThat(post("/login-methods/"+external+"/unlink",f.tokens().accessToken(),A,Map.of()).statusCode()).isEqualTo(503);
        assertThat(sessions.resolveAccessForAuth(f.tokens().accessToken())).isPresent();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_external_identity WHERE id=?",Integer.class,external)).isEqualTo(1);
    }
    private String external(String user){String identity=id();jdbc.update("INSERT INTO auth_external_identity(id,user_id,provider,issuer,subject) VALUES(?,?,'GOOGLE','https://accounts.google.com',?)",identity,user,id());return identity;}
    private HttpResponse<String> page(String endpoint,Fixture fixture,String query)throws Exception {
        return HTTP.send(HttpRequest.newBuilder(uri("/api/v1/sessions/"+endpoint+query)).timeout(Duration.ofSeconds(10))
                .header("Origin",A).header("Authorization","Bearer "+fixture.tokens().accessToken()).GET().build(),HttpResponse.BodyHandlers.ofString());
    }
    private Fixture fixture(String origin,Set<String> scopes){
        String email=id()+"@example.test";
        String user=accounts.registerAfterMailboxVerification(id(),email,"Self API fixture","A self service testing phrase","en",id());
        return grant(user,email,sessions.createAuthentication(user,true),origin,scopes);
    }
    private Fixture grant(String user,String email,SessionService.AuthenticationCreated root,String origin,Set<String> scopes){
        String app=id(),registered=id(),client="self-"+id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Self API test','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account profile')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,origin+"/callback");
        var tokens=sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,scopes));
        return new Fixture(user,email,app,client,root,tokens);
    }
    private HttpResponse<String> get(String token,String origin)throws Exception{
        return HTTP.send(HttpRequest.newBuilder(uri("/api/v1/users/me")).GET().header("Origin",origin).header("Authorization","Bearer "+token).build(),HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<String> post(String path,String token,String origin,Object body)throws Exception{
        return HTTP.send(HttpRequest.newBuilder(uri("/api/v1/sessions"+path)).timeout(Duration.ofSeconds(10)).header("Origin",origin)
                .header("Authorization","Bearer "+token).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    private URI uri(String path){return URI.create("http://127.0.0.1:"+port+path);}
    private static JsonNode json(HttpResponse<String> response){return JSON.readTree(response.body());}
    private static String id(){return UUID.randomUUID().toString();}
    private record Fixture(String user,String email,String app,String client,SessionService.AuthenticationCreated root,SessionService.TokenPair tokens){}
}
