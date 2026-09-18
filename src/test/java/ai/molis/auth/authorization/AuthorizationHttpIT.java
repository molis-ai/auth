package ai.molis.auth.authorization;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.service.ServiceIdentityService;
import ai.molis.auth.session.SessionService;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
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

/** Actual dual-identity HTTP/SQL decisions; trusted test fixtures preverify identities, not resource ownership. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=false","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080"})
class AuthorizationHttpIT {
    @org.springframework.test.context.bean.override.mockito.MockitoBean ai.molis.auth.verification.RedisRateLimiter limiter;
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired ServiceIdentityService services;
    @Autowired org.mybatis.spring.SqlSessionTemplate sql;
    @MockitoSpyBean AuthorizationMapper mapper;
    private static final JsonMapper JSON=JsonMapper.builder().build();
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
    @Test void authorizationRateLimitAndOutageFailClosed()throws Exception{
        var f=fixture(SpaceRole.MEMBER);
        doThrow(new ai.molis.auth.verification.EphemeralFailure(ai.molis.auth.verification.EphemeralFailure.Reason.RATE_LIMITED,17))
                .when(limiter).acquire(eq(ai.molis.auth.verification.RedisRateLimiter.Bucket.AUTHORIZATION_TOKEN),anyString());
        var limited=check(f,"feed.read");assertThat(limited.statusCode()).isEqualTo(429);
        assertThat(limited.headers().firstValue("Retry-After").orElseThrow()).isEqualTo("17");assertThat(code(limited)).isEqualTo("RATE_LIMITED");
        reset(limiter);
        doThrow(new ai.molis.auth.verification.EphemeralFailure(ai.molis.auth.verification.EphemeralFailure.Reason.UNAVAILABLE))
                .when(limiter).acquire(eq(ai.molis.auth.verification.RedisRateLimiter.Bucket.AUTHORIZATION_IP),anyString());
        var unavailable=check(f,"feed.read");assertThat(unavailable.statusCode()).isEqualTo(503);
        assertThat(code(unavailable)).isEqualTo("AUTH_UNAVAILABLE");assertThat(data(unavailable).has("allowed")).isFalse();
    }
    @Test void onlyExplicitDualIdentityActivityUpdatesIdleDeadlineAndAuditIsAtomic()throws Exception{
        var f=fixture(SpaceRole.MEMBER);
        jdbc.update("UPDATE auth_authentication_session SET authenticated_at=UTC_TIMESTAMP(6)-INTERVAL 2 DAY,last_user_activity_at=UTC_TIMESTAMP(6)-INTERVAL 1 DAY WHERE id=?",f.user().root().authenticationId());
        jdbc.update("UPDATE auth_authorization_session SET last_user_activity_at=UTC_TIMESTAMP(6)-INTERVAL 1 DAY WHERE id=?",sessions.resolveAccessForAuth(f.user().tokens().accessToken()).orElseThrow().sessionId());
        String root=f.user().root().authenticationId();var before=jdbc.queryForObject("SELECT last_user_activity_at FROM auth_authentication_session WHERE id=?",java.sql.Timestamp.class,root);
        assertThat(check(f,"feed.read").statusCode()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT last_user_activity_at FROM auth_authentication_session WHERE id=?",java.sql.Timestamp.class,root)).isEqualTo(before);
        assertThat(post(f,"activity",Map.of("userId",f.user().id())).statusCode()).isEqualTo(400);
        assertThat(send("activity",null,f.user().tokens().accessToken(),Map.of(),Map.of()).statusCode()).isEqualTo(401);
        doThrow(new DataAccessResourceFailureException("private activity audit failure")).when(mapper).audit(any());
        assertThat(post(f,"activity",Map.of()).statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT last_user_activity_at FROM auth_authentication_session WHERE id=?",java.sql.Timestamp.class,root)).isEqualTo(before);
        reset(mapper);
        var recorded=post(f,"activity",Map.of());assertThat(recorded.statusCode()).isEqualTo(200);assertThat(data(recorded).path("recorded").asBoolean()).isTrue();
        assertThat(jdbc.queryForObject("SELECT last_user_activity_at FROM auth_authentication_session WHERE id=?",java.sql.Timestamp.class,root)).isAfter(before);
    }
    @Test void actualEndpointEnforcesTheFixedRoleMatrix()throws Exception{
        for(var role:SpaceRole.values()){
            var f=fixture(role);
            for(String action:List.of("project.read","feed.read","project.create","feed.manage","goal.approve","project.delete")){
                boolean expected=action.endsWith(".read")||action.equals("project.create")&&role!=SpaceRole.VIEWER
                        ||!action.equals("project.create")&&(role==SpaceRole.OWNER||role==SpaceRole.ADMIN);
                var response=check(f,action);
                assertThat(response.statusCode()).isEqualTo(200);assertThat(data(response).path("allowed").asBoolean()).as(role+" "+action).isEqualTo(expected);
            }
        }
    }
    @Test void allowedActionsIntersectAppCatalogAndRecheckAtExecutionTime()throws Exception{
        var f=fixture(SpaceRole.MEMBER,"feed.read","feed.manage","project.create");
        var response=post(f,"allowed-actions",Map.of("spaceId",f.space()));
        assertThat(response.statusCode()).isEqualTo(200);assertThat(strings(data(response).path("allowedActions"))).containsExactly("feed.read","project.create");
        jdbc.update("UPDATE auth_membership SET role='VIEWER' WHERE space_id=? AND user_id=?",f.space(),f.user().id());
        assertThat(data(check(f,"project.create")).path("allowed").asBoolean()).isFalse();
        assertThat(strings(data(post(f,"allowed-actions",Map.of("spaceId",f.space()))).path("allowedActions"))).containsExactly("feed.read");
    }
    @Test void unknownActionEmptyCatalogAndCatalogRemovalDenyWithoutFinalDecisionCache()throws Exception{
        var f=fixture(SpaceRole.OWNER,"feed.read");
        assertThat(data(check(f,"project.read")).path("reason").asText()).isEqualTo("APPLICATION_ACTION_FORBIDDEN");
        assertThat(data(check(f,"project.destroy")).path("reason").asText()).isEqualTo("UNKNOWN_ACTION");
        assertThat(data(check(f,"feed.read")).path("allowed").asBoolean()).isTrue();
        jdbc.update("DELETE FROM auth_application_permission WHERE application_id=?",f.app());
        assertThat(data(check(f,"feed.read")).path("reason").asText()).isEqualTo("APPLICATION_ACTION_FORBIDDEN");
        assertThat(strings(data(post(f,"allowed-actions",Map.of("spaceId",f.space()))).path("allowedActions"))).isEmpty();
        assertThat(post(f,"spaces",Map.of("action","project.destroy")).statusCode()).isEqualTo(403);
    }
    @Test void serviceAndUserMustBelongToTheSameApplication()throws Exception{
        var a=fixture(SpaceRole.OWNER);var b=fixture(SpaceRole.OWNER);
        var response=send("check",a.serviceToken(),b.user().tokens().accessToken(),Map.of("spaceId",b.space(),"action","project.read"),Map.of());
        assertThat(response.statusCode()).isEqualTo(403);assertThat(code(response)).isEqualTo("APPLICATION_MISMATCH");
        assertThat(response.body()).doesNotContain(b.user().id(),b.app());
        assertThat(jdbc.queryForObject("SELECT actor_service_client_id FROM auth_audit_event WHERE decision_id=?",String.class,decision(response))).isEqualTo(a.service().id());
    }
    @Test void bothExplicitTokenHeadersAreRequiredAndTypesCannotBeSwapped()throws Exception{
        var f=fixture(SpaceRole.MEMBER);var body=Map.of("spaceId",f.space(),"action","project.read");
        assertThat(send("check",null,f.user().tokens().accessToken(),body,Map.of()).statusCode()).isEqualTo(401);
        assertThat(send("check",f.serviceToken(),null,body,Map.of("Cookie","auth_session_dev="+f.user().root().cookieSecret())).statusCode()).isEqualTo(401);
        assertThat(send("check",f.user().tokens().accessToken(),f.serviceToken(),body,Map.of()).statusCode()).isEqualTo(401);
        assertThat(send("check",f.serviceToken(),f.user().tokens().refreshToken(),body,Map.of()).statusCode()).isEqualTo(401);
        var req=HttpRequest.newBuilder(uri("check")).header("Content-Type","application/json").header("Authorization","Bearer "+f.serviceToken())
                .header("Authorization","Bearer "+f.serviceToken()).header("X-User-Token",f.user().tokens().accessToken()).POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        assertThat(HTTP.send(req.build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }
    @Test void profileOnlyTokenAndRevokedUserOrServiceCannotAuthorize()throws Exception{
        var f=fixture(SpaceRole.MEMBER);var profile=actor(f.client(),Set.of("profile"));
        membership(f.space(),profile.id(),SpaceRole.MEMBER);
        var response=send("check",f.serviceToken(),profile.tokens().accessToken(),Map.of("spaceId",f.space(),"action","project.read"),Map.of());
        assertThat(response.statusCode()).isEqualTo(403);assertThat(code(response)).isEqualTo("USER_SCOPE_REQUIRED");
        services.disable(f.service().clientId(),f.owner().id(),id());assertThat(code(check(f,"project.read"))).isEqualTo("SERVICE_UNAUTHENTICATED");
        var second=fixture(SpaceRole.OWNER);sessions.revokeAll(second.user().id());
        assertThat(code(check(second,"project.read"))).isEqualTo("USER_UNAUTHENTICATED");
    }
    @Test void missingMembershipAndMissingSpaceDenyWithoutLeakingExistence()throws Exception{
        var f=fixture(SpaceRole.MEMBER);
        jdbc.update("DELETE FROM auth_membership WHERE space_id=? AND user_id=?",f.space(),f.user().id());
        assertThat(data(check(f,"project.read")).path("reason").asText()).isEqualTo("NO_MEMBERSHIP");
        var missing=post(f,"check",Map.of("spaceId",id(),"action","project.read"));
        assertThat(data(missing).path("reason").asText()).isEqualTo("NO_MEMBERSHIP");
        assertThat(post(f,"allowed-actions",Map.of("spaceId",f.space())).statusCode()).isEqualTo(403);
    }
    @Test void archivedSpaceRetainsReadsButBlocksOrdinaryWrites()throws Exception{
        var f=fixture(SpaceRole.OWNER);jdbc.update("UPDATE auth_space SET status='ARCHIVED' WHERE id=?",f.space());
        assertThat(data(check(f,"feed.read")).path("allowed").asBoolean()).isTrue();
        assertThat(data(check(f,"feed.manage")).path("reason").asText()).isEqualTo("ARCHIVED_SPACE");
        assertThat(data(check(f,"space.restore")).path("allowed").asBoolean()).isTrue();
        assertThat(strings(data(post(f,"allowed-actions",Map.of("spaceId",f.space()))).path("allowedActions"))).contains("feed.read","space.restore").doesNotContain("feed.manage","project.create");
    }
    @Test void personalSpaceCannotBeUsedThroughAnIllegallyInsertedMembership()throws Exception{
        var f=fixture(SpaceRole.MEMBER);String personal=id();
        jdbc.update("INSERT INTO auth_space(id,name,space_type,status,personal_user_id) VALUES(?,'Personal test','PERSONAL','ACTIVE',?)",personal,f.owner().id());
        membership(personal,f.owner().id(),SpaceRole.OWNER);membership(personal,f.user().id(),SpaceRole.VIEWER);
        var denied=post(f,"check",Map.of("spaceId",personal,"action","project.read"));
        assertThat(data(denied).path("reason").asText()).isEqualTo("NO_MEMBERSHIP");
        assertThat(data(post(f,"spaces",Map.of("action","project.read"))).path("spaces").toString()).doesNotContain(personal);
    }
    @Test void accessibleSpacesApplyMembershipRoleAndArchiveFiltersBeforePagination()throws Exception{
        var f=fixture(SpaceRole.VIEWER);
        String prefix=id().substring(0,24); // Unique per run while retaining a deterministic ordered final segment.
        String absent=prefix+"000000000000",viewer=prefix+"000000000001",archived=prefix+"000000000002",first=prefix+"000000000003",second=prefix+"000000000004";
        for(String space:List.of(absent,viewer,archived,first,second)){team(space);membership(space,f.owner().id(),SpaceRole.OWNER);}
        membership(viewer,f.user().id(),SpaceRole.VIEWER);membership(archived,f.user().id(),SpaceRole.MEMBER);
        jdbc.update("UPDATE auth_space SET status='ARCHIVED' WHERE id=?",archived);
        membership(first,f.user().id(),SpaceRole.MEMBER);membership(second,f.user().id(),SpaceRole.ADMIN);
        var page1=post(f,"spaces",Map.of("action","project.create","limit",1));
        assertThat(page1.statusCode()).isEqualTo(200);assertThat(data(page1).path("spaces").size()).isEqualTo(1);
        assertThat(data(page1).path("spaces").get(0).path("id").asText()).isEqualTo(first);
        assertThat(data(page1).path("nextCursor").asText()).isEqualTo(first);
        var page2=post(f,"spaces",Map.of("action","project.create","limit",1,"cursor",first));
        assertThat(data(page2).path("spaces").get(0).path("id").asText()).isEqualTo(second);assertThat(data(page2).path("nextCursor").isNull()).isTrue();
        assertThat(post(f,"spaces",Map.of("action","project.create","limit",201)).statusCode()).isEqualTo(400);
    }
    @Test void permissionDowngradeBeforeMembershipReadCannotUseAnEarlierRole()throws Exception{
        var f=fixture(SpaceRole.MEMBER);var reached=new CountDownLatch(1);var release=new CountDownLatch(1);
        doAnswer(invocation->{reached.countDown();if(!release.await(8,TimeUnit.SECONDS))throw new IllegalStateException("Test release timed out");
            return sql.getMapper(AuthorizationMapper.class).membership(f.space(),f.user().id());})
                .when(mapper).membership(f.space(),f.user().id());
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var response=executor.submit(()->check(f,"project.create"));
            try{assertThat(reached.await(5,TimeUnit.SECONDS)).isTrue();jdbc.update("UPDATE auth_membership SET role='VIEWER' WHERE space_id=? AND user_id=?",f.space(),f.user().id());}
            finally{release.countDown();}
            var finished=response.get(10,TimeUnit.SECONDS);assertThat(finished.statusCode()).isEqualTo(200);
            assertThat(data(finished).path("reason").asText()).isEqualTo("ROLE_FORBIDDEN");
        }
    }
    @Test void auditFailureAndStoreFailureRemainUnavailableNotAllowOrBusinessDeny()throws Exception{
        var f=fixture(SpaceRole.MEMBER);
        doThrow(new DataAccessResourceFailureException("private authorization audit detail")).when(mapper).audit(any());
        var response=check(f,"project.read");assertThat(response.statusCode()).isEqualTo(503);assertThat(code(response)).isEqualTo("AUTH_UNAVAILABLE");
        assertThat(response.body()).doesNotContain("private authorization audit detail","allowed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE decision_id=?",Integer.class,decision(response))).isZero();
        reset(mapper);doThrow(new DataAccessResourceFailureException("private space detail")).when(mapper).lockSpace(f.space());
        assertThat(check(f,"project.read").statusCode()).isEqualTo(503);
    }
    @Test void decisionsHaveServerGeneratedCorrelatedAuditWithoutBearerOrBusinessPayload()throws Exception{
        var f=fixture(SpaceRole.MEMBER);var response=send("check",f.serviceToken(),f.user().tokens().accessToken(),
                Map.of("spaceId",f.space(),"action","feed.manage","resourceType","feed","resourceId","feed_123"),Map.of("X-Request-ID","caller-supplied","X-Decision-ID","caller-decision"));
        String decision=decision(response);assertThat(decision).matches("[0-9a-f-]{36}").isNotEqualTo("caller-decision");
        var audit=jdbc.queryForMap("SELECT request_id,decision_id,requested_action,denial_reason,resource_type,resource_id,actor_user_id,actor_service_client_id FROM auth_audit_event WHERE decision_id=?",decision);
        assertThat(audit.get("request_id")).isEqualTo(response.headers().firstValue("X-Request-ID").orElseThrow());
        assertThat(audit.get("requested_action")).isEqualTo("feed.manage");assertThat(audit.get("denial_reason")).isEqualTo("ROLE_FORBIDDEN");
        assertThat(audit.get("resource_id")).isEqualTo("feed_123");assertThat(audit.toString()).doesNotContain(f.serviceToken(),f.user().tokens().accessToken());
        assertThat(response.headers().firstValue("Cache-Control").orElseThrow()).isEqualTo("no-store");
    }
    @Test void requestCannotAssertItsOwnRoleUserOrAppAndBrowserCannotCallBackendApi()throws Exception{
        var f=fixture(SpaceRole.VIEWER);var body=new HashMap<String,Object>(Map.of("spaceId",f.space(),"action","feed.manage"));
        body.put("role","OWNER");body.put("userId",f.owner().id());body.put("applicationId",f.app());
        assertThat(post(f,"check",body).statusCode()).isEqualTo(400);
        assertThat(send("check",f.serviceToken(),f.user().tokens().accessToken(),Map.of("spaceId",f.space(),"action","project.read"),Map.of("Origin","https://product.example.test")).statusCode()).isEqualTo(403);
        assertThat(post(f,"check?role=OWNER",Map.of("spaceId",f.space(),"action","project.read")).statusCode()).isEqualTo(400);
        var leak=post(f,"check",Map.of("spaceId",f.space(),"action","project.read","resourceType","project","resourceId",f.user().tokens().accessToken()));
        assertThat(leak.statusCode()).isEqualTo(400);
        var duplicate=HttpRequest.newBuilder(uri("check")).header("Content-Type","application/json").header("Authorization","Bearer "+f.serviceToken())
                .header("X-User-Token",f.user().tokens().accessToken()).POST(HttpRequest.BodyPublishers.ofString("{\"spaceId\":\""+f.space()+"\",\"action\":\"feed.read\",\"action\":\"feed.manage\"}"));
        assertThat(HTTP.send(duplicate.build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(400);
    }
    private Fixture fixture(SpaceRole role,String...catalog){
        String app=id(),client="authz-web-"+id(),registered=id(),space=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES(?,'Authorization test','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(?,?,?,'WEB','ACTIVE','account profile')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES(?,'https://authz-product.example.test/callback')",registered);
        Collection<String> actions=catalog.length==0?new FixedPermissionPolicy().catalog():List.of(catalog);
        for(String action:actions)jdbc.update("INSERT INTO auth_application_permission(application_id,action) VALUES(?,?)",app,action);
        var owner=actor(client,Set.of("account"));team(space);membership(space,owner.id(),SpaceRole.OWNER);
        var user=role==SpaceRole.OWNER?owner:actor(client,Set.of("account"));if(user!=owner)membership(space,user.id(),role);
        var service=services.create(app,"Authorization backend",owner.id(),id());
        String token=services.issue(services.authenticate(service.clientId(),service.secret()),Set.of(),id()).accessToken();
        return new Fixture(app,client,space,service,token,user,owner);
    }
    private Actor actor(String client,Set<String> scopes){String user=id();jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES(?,'Preverified fixture','ACTIVE')",user);var root=sessions.createAuthentication(user,true);return new Actor(user,root,sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,scopes)));}
    private void team(String space){jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Team fixture','TEAM','ACTIVE')",space);}
    private void membership(String space,String user,SpaceRole role){jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,?)",space,user,role.name());}
    private HttpResponse<String> check(Fixture f,String action)throws Exception{return post(f,"check",Map.of("spaceId",f.space(),"action",action));}
    private HttpResponse<String> post(Fixture f,String path,Object body)throws Exception{return send(path,f.serviceToken(),f.user().tokens().accessToken(),body,Map.of());}
    private HttpResponse<String> send(String path,String service,String user,Object body,Map<String,String> headers)throws Exception{
        var request=HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(15)).header("Content-Type","application/json");
        if(service!=null)request.header("Authorization","Bearer "+service);if(user!=null)request.header("X-User-Token",user);headers.forEach(request::header);
        return HTTP.send(request.POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    private URI uri(String path){return URI.create("http://127.0.0.1:"+port+"/api/v1/authorization/"+path);}
    private static JsonNode data(HttpResponse<String> response){return JSON.readTree(response.body()).path("data");}
    private static String code(HttpResponse<String> response){return JSON.readTree(response.body()).path("error").path("code").asText();}
    private static String decision(HttpResponse<String> response){return response.headers().firstValue("X-Decision-ID").orElseThrow();}
    private static List<String> strings(JsonNode array){var result=new ArrayList<String>();array.forEach(value->result.add(value.asText()));return result;}
    private static String id(){return UUID.randomUUID().toString();}
    private record Actor(String id,SessionService.AuthenticationCreated root,SessionService.TokenPair tokens){}
    private record Fixture(String app,String client,String space,ServiceIdentityService.Created service,String serviceToken,Actor user,Actor owner){}
}
