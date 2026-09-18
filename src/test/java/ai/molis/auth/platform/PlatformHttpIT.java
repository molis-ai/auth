package ai.molis.auth.platform;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.service.*;
import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real HTTP/MySQL management. Fixtures preverify test identities; no production admin-registration shortcut. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080"})
class PlatformHttpIT {
    private static final List<String> ADMINS=IntStream.range(0,40).mapToObj(i->id()).toList();
    private static final AtomicInteger NEXT=new AtomicInteger();
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired ServiceIdentityService services;
    @Autowired org.mybatis.spring.SqlSessionTemplate sql;
    @MockitoBean RedisRateLimiter unusedLoginLimiter;
    @MockitoSpyBean PlatformMapper mapper;
    @MockitoSpyBean ServiceIdentityMapper serviceMapper;
    @MockitoSpyBean ai.molis.auth.session.SessionMapper sessionMapper;
    Actor admin;
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p){
        p.add("auth.platform.admin-user-ids",()->String.join(",",ADMINS));
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");
            if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable local database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    @BeforeEach void setup(){admin=actor(ADMINS.get(NEXT.getAndIncrement()),Set.of("account"));}
    @AfterEach void noLoginProofShortcut(){verify(unusedLoginLimiter,never()).acquire(eq(RedisRateLimiter.Bucket.LOGIN_IP),anyString());}
    @AfterAll static void close(){HTTP.close();}

    @Test void editableMatrixPersistsAndUpdatesEveryDecisionSurface()throws Exception{
        String app=admin.app(), path="applications/"+app+"/permission-matrix";
        jdbc.update("INSERT INTO auth_application_permission(application_id,action) VALUES(?,'feed.read'),(?,'feed.manage')",app,app);
        long version=data(get(path)).path("application").path("version").asLong();
        var regular=actor(id(),Set.of("account"));
        assertThat(send("PUT",path,regular.tokens().accessToken(),Map.of("version",version,"grants",List.of()),Map.of()).statusCode()).isEqualTo(403);
        assertThat(put(path,Map.of("version",version,"grants",List.of("MEMBER:unknown.action"))).statusCode()).isEqualTo(400);
        var saved=put(path,Map.of("version",version,"grants",List.of("MEMBER:feed.read","MEMBER:feed.manage")));
        assertThat(saved.statusCode()).as(saved.body()).isEqualTo(200);
        assertThat(put(path,Map.of("version",version,"grants",List.of())).statusCode()).isEqualTo(409);
        assertThat(jdbc.queryForObject("SELECT change_summary FROM auth_audit_event WHERE request_id=?",String.class,requestId(saved))).contains("MEMBER:feed.manage=true");
        var service=services.create(app,"Matrix enforcement",admin.id(),id());
        String token=services.issue(services.authenticate(service.clientId(),service.secret()),Set.of(),id()).accessToken();
        var spaces=new ArrayList<String>();
        for(int i=0;i<2;i++){
            String space=id();spaces.add(space);
            jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Matrix team','TEAM','ACTIVE')",space);
            jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,'MEMBER')",space,admin.id());
            assertThat(authDecision("check",token,Map.of("spaceId",space,"action","feed.manage")).path("allowed").asBoolean()).isTrue();
            assertThat(authDecision("allowed-actions",token,Map.of("spaceId",space)).path("allowedActions").toString()).contains("feed.manage");
        }
        var accessible=authDecision("spaces",token,Map.of("action","feed.manage"));
        for(String space:spaces)assertThat(accessible.toString()).contains(space);
        jdbc.update("UPDATE auth_space SET status='ARCHIVED' WHERE id=?",spaces.getFirst());
        assertThat(authDecision("check",token,Map.of("spaceId",spaces.getFirst(),"action","feed.manage")).path("allowed").asBoolean()).isFalse();
        assertThat(put(path,Map.of("version",version+1,"grants",List.of())).statusCode()).isEqualTo(200);
        assertThat(authDecision("check",token,Map.of("spaceId",spaces.getLast(),"action","feed.manage")).path("allowed").asBoolean()).isFalse();
        assertThat(authDecision("spaces",token,Map.of("action","feed.manage")).path("spaces").size()).isZero();
        String client=jdbc.queryForObject("SELECT id FROM auth_login_client WHERE application_id=? LIMIT 1",String.class,app);
        jdbc.update("UPDATE auth_console_registration SET application_id=?,login_client_id=? WHERE id='console'",app,client);
        try{assertThat(put(path,Map.of("version",version+2,"grants",List.of())).statusCode()).isEqualTo(403);}
        finally{jdbc.update("UPDATE auth_console_registration SET application_id=NULL,login_client_id=NULL WHERE id='console'");}
    }
    @Test void permissionSaveRollsBackWhenAuditFails()throws Exception{
        String app=newApp();assertThat(updateApp(app,"ACTIVE",List.of("feed.read","feed.manage"),data(get("applications/"+app)).path("version").asLong()).statusCode()).isEqualTo(200);
        String path="applications/"+app+"/permission-matrix";long version=data(get(path)).path("application").path("version").asLong();
        doThrow(new DataAccessResourceFailureException("test audit failure")).when(mapper).audit(argThat(a->"platform.permissions.update".equals(a.action())));
        assertThat(put(path,Map.of("version",version,"grants",List.of("MEMBER:feed.manage"))).statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT version FROM auth_application WHERE id=?",Long.class,app)).isEqualTo(version);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_application_role_permission WHERE application_id=?",Integer.class,app)).isZero();
    }
    private JsonNode authDecision(String operation,String token,Object body)throws Exception{
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/authorization/"+operation)).header("Content-Type","application/json")
          .header("Authorization","Bearer "+token).header("X-User-Token",admin.tokens().accessToken()).POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        var response=HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return data(response);
    }
    @Test void permissionMatrixUsesApplicationAllowlistAndFixedRoles()throws Exception{
        var created=post("applications",Map.of("name","Matrix test","actions",List.of("feed.read","feed.manage")));
        String app=data(created).path("id").asText();
        var response=get("applications/"+app+"/permission-matrix");
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        var roles=data(response).path("roles");
        assertThat(roles.size()).isEqualTo(4);
        assertThat(roles.get(0).path("role").asText()).isEqualTo("OWNER");
        assertThat(roles.get(0).path("actions").size()).isEqualTo(2);
        assertThat(roles.get(2).path("actions").size()).isEqualTo(1);
        assertThat(roles.get(2).path("actions").get(0).asText()).isEqualTo("feed.read");
        var user=actor(id(),Set.of("account"));
        assertThat(send("GET","applications/"+app+"/permission-matrix",user.tokens().accessToken(),null,Map.of()).statusCode()).isEqualTo(403);
        jdbc.update("UPDATE auth_application SET status='DISABLED' WHERE id=?",app);
        for(var role:data(get("applications/"+app+"/permission-matrix")).path("roles"))assertThat(role.path("actions").size()).isZero();
    }
    @Test void onlyWhitelistedActiveUserBearerWithAccountScopeCanAdminister()throws Exception{
        assertThat(get("me").statusCode()).isEqualTo(200);
        var user=actor(id(),Set.of("account"));String space=id();
        jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Owner is not platform admin','TEAM','ACTIVE')",space);
        jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,'OWNER')",space,user.id());
        var denied=send("GET","applications",user.tokens().accessToken(),null,Map.of());
        assertThat(denied.statusCode()).isEqualTo(403);assertThat(code(denied)).isEqualTo("PLATFORM_ADMIN_REQUIRED");
        assertThat(jdbc.queryForObject("SELECT outcome FROM auth_audit_event WHERE request_id=?",String.class,requestId(denied))).isEqualTo("DENIED");
        var profile=actor(ADMINS.get(NEXT.getAndIncrement()),Set.of("profile"));
        assertThat(code(send("GET","me",profile.tokens().accessToken(),null,Map.of()))).isEqualTo("ACCOUNT_SCOPE_REQUIRED");
        assertThat(send("GET","me",admin.tokens().refreshToken(),null,Map.of()).statusCode()).isEqualTo(401);
        var service=services.create(admin.app(),"Wrong identity type",admin.id(),id());
        String token=services.issue(services.authenticate(service.clientId(),service.secret()),Set.of(),id()).accessToken();
        assertThat(send("GET","me",token,null,Map.of()).statusCode()).isEqualTo(401);
        assertThat(send("GET","me",null,null,Map.of("Cookie","auth_session_dev="+admin.root().cookieSecret())).statusCode()).isEqualTo(401);
        sessions.revokeAll(admin.id());assertThat(get("me").statusCode()).isEqualTo(401);
    }
    @Test void originAndStrictRequestBoundaryPreventMassAssignmentAndCookieCsrf()throws Exception{
        assertThat(send("GET","me",admin.tokens().accessToken(),null,Map.of("Origin","http://localhost:8080")).statusCode()).isEqualTo(200);
        assertThat(send("GET","me",admin.tokens().accessToken(),null,Map.of("Origin","https://admin-product.example.test")).statusCode()).isEqualTo(403);
        assertThat(send("GET","me",admin.tokens().accessToken(),null,Map.of("Sec-Fetch-Site","cross-site")).statusCode()).isEqualTo(403);
        assertThat(post("applications",Map.of("name","Mass assignment","actions",List.of(),"adminUserIds",List.of(admin.id()))).statusCode()).isEqualTo(400);
        for(String raw:List.of("{\"name\":\"a\",\"name\":\"b\",\"actions\":[]}","{\"name\":\"a\",\"actions\":[]} {}","{\"name\":7,\"actions\":[]}"))
            assertThat(raw("POST","applications",raw).statusCode()).isEqualTo(400);
        assertThat(get("applications?limit=1&limit=2").statusCode()).isEqualTo(400);
        assertThat(get("me?userId="+id()).statusCode()).isEqualTo(400);
        assertThat(get("applications?limit=201").statusCode()).isEqualTo(400);
        assertThat(raw("POST","applications"," ".repeat(16385)).statusCode()).isEqualTo(413);
    }
    @Test void applicationCatalogIsFixedExplicitAndVersionChecked()throws Exception{
        String app=newApp();var first=get("applications/"+app);assertThat(data(first).path("actions").isEmpty()).isTrue();
        assertThat(updateApp(app,"ACTIVE",List.of("feed.read"),0).statusCode()).isEqualTo(200);
        assertThat(data(get("applications/"+app)).path("version").asLong()).isEqualTo(1);
        assertThat(code(updateApp(app,"ACTIVE",List.of("feed.manage"),0))).isEqualTo("VERSION_CONFLICT");
        assertThat(updateApp(app,"ACTIVE",List.of("arbitrary.permission"),1).statusCode()).isEqualTo(400);
        assertThat(data(get("applications/"+app)).path("actions").toString()).isEqualTo("[\"feed.read\"]");
        assertThat(get("permission-catalog").body()).contains("feed.read","feed.manage").doesNotContain("platform.admin");
    }
    @Test void concurrentConfigurationEditsCannotSilentlyOverwriteEachOther()throws Exception{
        String app=newApp();try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var a=executor.submit(()->updateApp(app,"ACTIVE",List.of("feed.read"),0));
            var b=executor.submit(()->updateApp(app,"ACTIVE",List.of("feed.manage"),0));
            assertThat(List.of(a.get(15,TimeUnit.SECONDS).statusCode(),b.get(15,TimeUnit.SECONDS).statusCode())).containsExactlyInAnyOrder(200,409);
        }
    }
    @Test void loginClientConfigurationIsExactBoundedAndRevokesExistingGrants()throws Exception{
        String app=newApp(),client="managed-"+id();var body=clientBody(client,"WEB","https://product.example.test/callback");
        assertThat(post("applications/"+app+"/clients",body).statusCode()).isEqualTo(200);
        assertThat(post("applications/"+app+"/clients",body).statusCode()).isEqualTo(409);
        var root=sessions.createAuthentication(admin.id(),true);var tokens=sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,Set.of("account")));
        var update=Map.of("status","ACTIVE","scopes",List.of("account"),"redirects",List.of("https://product.example.test/new"),"version",0);
        assertThat(put("clients/"+client,update).statusCode()).isEqualTo(200);assertThat(sessions.resolveAccessForAuth(tokens.accessToken())).isEmpty();
        assertThat(sessions.resolveAccessForAuth(admin.tokens().accessToken())).isPresent();
        assertThat(put("clients/"+client,update).statusCode()).isEqualTo(409);
        var current=get("clients/"+client);assertThat(current.body()).contains("https://product.example.test/new").doesNotContain("/callback");
        assertThat(data(get("applications/"+app+"/clients")).path("items").size()).isEqualTo(1);
        for(String redirect:List.of("https://*.example.test/callback","http://public.example.test/callback","https://product.example.test/callback#secret","https://user@product.example.test/callback","https://product.example.test/callback?%73tate=x"))
            assertThat(post("applications/"+app+"/clients",clientBody("bad-"+id(),"WEB",redirect)).statusCode()).isEqualTo(400);
        assertThat(post("applications/"+app+"/clients",clientBody("svc_"+id(),"WEB","http://127.0.0.1/callback")).statusCode()).isEqualTo(400);
        assertThat(post("applications/"+app+"/clients",clientBody("native-"+id(),"MACOS","ai.molis.app://oauth/callback")).statusCode()).isEqualTo(200);
        assertThat(post("applications/"+app+"/clients",clientBody("file-"+id(),"MACOS","file://host/path")).statusCode()).isEqualTo(400);
    }
    @Test void applicationDisableAndRestoreNeverResurrectOldUserOrServiceCredentials()throws Exception{
        String app=newApp(),client="disable-"+id();post("applications/"+app+"/clients",clientBody(client,"WEB","http://127.0.0.1/callback"));
        var root=sessions.createAuthentication(admin.id(),true);var tokens=sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,Set.of("account")));
        var created=data(post("applications/"+app+"/services",Map.of("name","Backend")));String service=created.path("clientId").asText(),secret=created.path("secret").asText();
        String token=services.issue(services.authenticate(service,secret),Set.of(),id()).accessToken();
        assertThat(updateApp(app,"DISABLED",List.of(),0).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveAccessForAuth(tokens.accessToken())).isEmpty();assertThat(services.resolve(token)).isEmpty();
        assertThat(sessions.resolveAccessForAuth(admin.tokens().accessToken())).isPresent();
        assertThat(updateApp(app,"ACTIVE",List.of(),1).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveAccessForAuth(tokens.accessToken())).isEmpty();assertThat(services.resolve(token)).isEmpty();
        assertThatThrownBy(()->services.authenticate(service,secret)).isInstanceOf(ServiceIdentityService.Rejected.class);
        var fresh=data(post("services/"+service+"/rotate",Map.of()));assertThat(services.authenticate(service,fresh.path("secret").asText())).isNotNull();
    }
    @Test void serviceSecretIsOneTimeResponseRotationAndDisableTakeImmediateEffect()throws Exception{
        String app=newApp();var response=post("applications/"+app+"/services",Map.of("name","Private backend"));
        assertThat(response.statusCode()).isEqualTo(200);var created=data(response);String client=created.path("clientId").asText(),secret=created.path("secret").asText();
        assertThat(secret).matches("[A-Za-z0-9_-]{43}");assertThat(get("applications/"+app+"/services").body()).doesNotContain(secret,"secret_hash","secretHash");
        String token=services.issue(services.authenticate(client,secret),Set.of(),id()).accessToken();
        var rotation=post("services/"+client+"/rotate",Map.of());String next=data(rotation).path("secret").asText();
        assertThat(rotation.statusCode()).isEqualTo(200);assertThat(services.resolve(token)).isEmpty();
        assertThatThrownBy(()->services.authenticate(client,secret)).isInstanceOf(ServiceIdentityService.Rejected.class);
        assertThat(post("services/"+client+"/disable",Map.of()).statusCode()).isEqualTo(200);
        assertThatThrownBy(()->services.authenticate(client,next)).isInstanceOf(ServiceIdentityService.Rejected.class);
        assertThat(post("services/"+client+"/rotate",Map.of()).statusCode()).isEqualTo(409);
        assertThat(get("audit?limit=200").body()).doesNotContain(secret,next,token);
    }
    @Test void disablingUserRevokesAllDevicesButRetainsMembershipAndRestoreNeedsFreshLogin()throws Exception{
        var user=actor(id(),Set.of("account"));var root2=sessions.createAuthentication(user.id(),true);var tokens2=sessions.issueInitial(sessions.createGrant(root2.authenticationId(),user.client(),Set.of("account")));
        String space=id();jdbc.update("INSERT INTO auth_space(id,name,space_type,status,personal_user_id) VALUES(?,'Personal preserved','PERSONAL','ACTIVE',?)",space,user.id());
        jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,'OWNER')",space,user.id());
        assertThat(put("users/"+user.id()+"/status",Map.of("status","DISABLED")).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveAccessForAuth(user.tokens().accessToken())).isEmpty();assertThat(sessions.resolveAccessForAuth(tokens2.accessToken())).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=? AND revoked_at IS NULL",Integer.class,user.id())).isZero();
        assertThat(jdbc.queryForObject("SELECT role FROM auth_membership WHERE space_id=? AND user_id=?",String.class,space,user.id())).isEqualTo("OWNER");
        assertThat(put("users/"+user.id()+"/status",Map.of("status","ACTIVE")).statusCode()).isEqualTo(200);
        assertThat(sessions.resolveAccessForAuth(user.tokens().accessToken())).isEmpty();assertThat(get("users/"+user.id()).body()).contains("ACTIVE");
        assertThat(sessions.createAuthentication(user.id(),true)).isNotNull();
    }
    @Test void managementAndSessionRevocationRollBackWhenAuditCannotBePersisted()throws Exception{
        var user=actor(id(),Set.of("account"));String app=newApp();
        doThrow(new DataAccessResourceFailureException("private audit backend detail")).when(mapper).audit(any());
        var failure=put("users/"+user.id()+"/status",Map.of("status","DISABLED"));
        assertThat(failure.statusCode()).isEqualTo(503);assertThat(failure.body()).doesNotContain("private audit backend detail");
        assertThat(sessions.resolveAccessForAuth(user.tokens().accessToken())).isPresent();
        assertThat(updateApp(app,"DISABLED",List.of("feed.read"),0).statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT status FROM auth_application WHERE id=?",String.class,app)).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT version FROM auth_application WHERE id=?",Long.class,app)).isZero();
    }
    @Test void serviceAuditFailureRollsBackCredentialRotationInTheManagementTransaction()throws Exception{
        String app=newApp();var created=data(post("applications/"+app+"/services",Map.of("name","Audit rollback")));
        String client=created.path("clientId").asText(),secret=created.path("secret").asText();
        doThrow(new DataAccessResourceFailureException("private service audit detail")).when(serviceMapper).audit(anyString(),eq("service.credential.rotate"),anyString(),anyString(),any(),anyString(),anyString(),anyString());
        assertThat(post("services/"+client+"/rotate",Map.of()).statusCode()).isEqualTo(503);
        assertThat(services.authenticate(client,secret)).isNotNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_service_credential WHERE service_client_id=?",Integer.class,created.path("id").asText())).isEqualTo(1);
    }
    @Test void disableCommittedBeforeAdminRevalidationCannotAuthorizeThePendingWrite()throws Exception{
        var reached=new CountDownLatch(1);var release=new CountDownLatch(1);
        var first=new java.util.concurrent.atomic.AtomicBoolean(true);
        // Real HTTP has already read the token locator, but has not yet obtained its user lock.
        doAnswer(invocation->{if(first.getAndSet(false)){reached.countDown();if(!release.await(8,TimeUnit.SECONDS))throw new IllegalStateException("Test release timed out");}
            return sql.getMapper(ai.molis.auth.session.SessionMapper.class).lockUser(admin.id());}).when(sessionMapper).lockUser(admin.id());
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var pending=executor.submit(()->post("applications",Map.of("name","Must not be created","actions",List.of())));
            try{assertThat(reached.await(5,TimeUnit.SECONDS)).isTrue();sessions.disableUser(admin.id());}finally{release.countDown();}
            var denied=pending.get(12,TimeUnit.SECONDS);assertThat(denied.statusCode()).isEqualTo(401);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE request_id=? AND outcome='SUCCESS'",Integer.class,requestId(denied))).isZero();
        }
    }
    @Test void platformWhitelistDoesNotGrantBusinessSpaceMembership()throws Exception{
        String space=id();jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Unrelated business space','TEAM','ACTIVE')",space);
        jdbc.update("INSERT INTO auth_application_permission(application_id,action) VALUES(?,'feed.read')",admin.app());
        var service=services.create(admin.app(),"Backend business identity",admin.id(),id());
        String token=services.issue(services.authenticate(service.clientId(),service.secret()),Set.of(),id()).accessToken();
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/authorization/check"))
                .timeout(Duration.ofSeconds(15)).header("Content-Type","application/json").header("Authorization","Bearer "+token)
                .header("X-User-Token",admin.tokens().accessToken()).POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(Map.of("spaceId",space,"action","feed.read"))));
        var response=HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString());assertThat(response.statusCode()).isEqualTo(200);
        assertThat(data(response).path("allowed").asBoolean()).isFalse();assertThat(data(response).path("reason").asText()).isEqualTo("NO_MEMBERSHIP");
    }
    @Test void paginatedViewsAndAuditAreMetadataOnlyWithServerCorrelation()throws Exception{
        var created=post("applications",Map.of("name","Correlated application","actions",List.of("feed.read")));String request=requestId(created);
        assertThat(request).matches("[0-9a-f-]{36}");assertThat(JSON.readTree(created.body()).path("requestId").asText()).isEqualTo(request);
        assertThat(created.headers().firstValue("Cache-Control").orElseThrow()).isEqualTo("no-store");
        var row=jdbc.queryForMap("SELECT actor_user_id,change_summary FROM auth_audit_event WHERE request_id=?",request);
        assertThat(row.get("actor_user_id")).isEqualTo(admin.id());assertThat(row.toString()).doesNotContain(admin.tokens().accessToken());
        var page=data(get("applications?limit=1"));assertThat(page.path("items").size()).isEqualTo(1);
        String cursor=page.path("nextCursor").asText();assertThat(data(get("applications?limit=1&cursor="+cursor)).path("items").get(0).path("id").asText()).isGreaterThan(cursor);
        assertThat(data(get("users?limit=1")).path("items").size()).isEqualTo(1);
        var audit=data(get("audit?limit=1"));assertThat(audit.path("items").size()).isEqualTo(1);
        assertThat(get("audit?limit=1&cursor="+audit.path("nextCursor").asText()).statusCode()).isEqualTo(200);
        assertThat(get("audit?cursor="+id()).statusCode()).isEqualTo(400);
    }
    @Test void manualMailRetryIsIdempotentAuditedAndPreservesOriginal()throws Exception{
        String original=failedMail("ACCOUNT_REGISTERED");
        var first=post("mail/"+original+"/resend",Map.of());assertThat(first.statusCode()).isEqualTo(200);
        String retry=data(first).path("id").asText();
        assertThat(data(post("mail/"+original+"/resend",Map.of())).path("id").asText()).isEqualTo(retry);
        assertThat(jdbc.queryForObject("SELECT status FROM auth_mail_outbox WHERE id=?",String.class,original)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT attempts FROM auth_mail_outbox WHERE id=?",Integer.class,original)).isEqualTo(5);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE resend_of=?",Integer.class,original)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE action='platform.mail.resend' AND request_id=?",Integer.class,requestId(first))).isEqualTo(1);
        assertThat(get("mail?limit=1").statusCode()).isEqualTo(200);
        assertThat(get("mail?limit=200").body()).doesNotContain("payload_encrypted","lease_token");
        jdbc.update("UPDATE auth_mail_outbox SET status='FAILED' WHERE id=?",retry);
        assertThat(code(post("mail/"+retry+"/resend",Map.of()))).isEqualTo("MAIL_NOT_RETRYABLE");
    }
    @Test void mailRetryRejectsVerificationActiveJobsAndNonAdministrators()throws Exception{
        for(String template:List.of("VERIFY_REGISTER","VERIFY_PASSWORD_RESET"))
            assertThat(code(post("mail/"+failedMail(template)+"/resend",Map.of()))).isEqualTo("MAIL_NOT_RETRYABLE");
        String original=failedMail("PASSWORD_CHANGED");jdbc.update("UPDATE auth_mail_outbox SET status='SENT' WHERE id=?",original);
        assertThat(post("mail/"+original+"/resend",Map.of()).statusCode()).isEqualTo(409);
        var ordinary=actor(id(),Set.of("account"));
        assertThat(send("GET","mail",ordinary.tokens().accessToken(),null,Map.of()).statusCode()).isEqualTo(403);
        assertThat(send("POST","mail/"+original+"/resend",ordinary.tokens().accessToken(),Map.of(),Map.of()).statusCode()).isEqualTo(403);
    }
    @Test void concurrentMailRetryCreatesOnlyOneJob()throws Exception{
        String original=failedMail("SPACE_INVITED");
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var a=executor.submit(()->post("mail/"+original+"/resend",Map.of()));
            var b=executor.submit(()->post("mail/"+original+"/resend",Map.of()));
            var ra=a.get(15,TimeUnit.SECONDS);var rb=b.get(15,TimeUnit.SECONDS);
            assertThat(ra.statusCode()).isEqualTo(200);assertThat(rb.statusCode()).isEqualTo(200);
            assertThat(data(ra).path("id").asText()).isEqualTo(data(rb).path("id").asText());
        }
    }
    @Test void mailRetryRollsBackWhenAuditFails()throws Exception{
        String original=failedMail("ACCOUNT_REGISTERED");
        doThrow(new DataAccessResourceFailureException("private mail audit failure")).when(mapper).audit(any());
        assertThat(post("mail/"+original+"/resend",Map.of()).statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE resend_of=?",Integer.class,original)).isZero();
    }
    private String failedMail(String template){String mail=id();jdbc.update("INSERT INTO auth_mail_outbox(id,recipient_email,template_key,locale,status,attempts,next_attempt_at,created_at) VALUES(?,'retry@example.test',?,'en','FAILED',5,CURRENT_TIMESTAMP(6),CURRENT_TIMESTAMP(6))",mail,template);return mail;}
    private Actor actor(String user,Set<String> scopes){String app=id(),registered=id(),client="platform-test-"+id();
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES(?,'Preverified platform test','ACTIVE')",user);
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES(?,'Admin console fixture','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(?,?,?,'WEB','ACTIVE','account profile')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES(?,'https://admin-product.example.test/callback')",registered);
        var root=sessions.createAuthentication(user,true);return new Actor(user,app,client,root,sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,scopes)));}
    private String newApp()throws Exception{var response=post("applications",Map.of("name","Managed test","actions",List.of()));assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return data(response).path("id").asText();}
    private Object clientBody(String client,String type,String redirect){return Map.of("clientId",client,"clientType",type,"scopes",List.of("account","profile"),"redirects",List.of(redirect));}
    private HttpResponse<String> updateApp(String app,String status,List<String> actions,long version)throws Exception{return put("applications/"+app,Map.of("name","Managed updated","status",status,"actions",actions,"version",version));}
    private HttpResponse<String> get(String path)throws Exception{return send("GET",path,admin.tokens().accessToken(),null,Map.of());}
    private HttpResponse<String> post(String path,Object body)throws Exception{return send("POST",path,admin.tokens().accessToken(),body,Map.of());}
    private HttpResponse<String> put(String path,Object body)throws Exception{return send("PUT",path,admin.tokens().accessToken(),body,Map.of());}
    private HttpResponse<String> raw(String method,String path,String body)throws Exception{return HTTP.send(builder(path).header("Authorization","Bearer "+admin.tokens().accessToken()).method(method,HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());}
    private HttpResponse<String> send(String method,String path,String token,Object body,Map<String,String> headers)throws Exception{
        var request=builder(path);if(token!=null)request.header("Authorization","Bearer "+token);headers.forEach(request::header);
        return HTTP.send(request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());}
    private HttpRequest.Builder builder(String path){return HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/api/v1/platform/"+path)).timeout(Duration.ofSeconds(15)).header("Content-Type","application/json");}
    private static JsonNode data(HttpResponse<String> response){return JSON.readTree(response.body()).path("data");}
    private static String code(HttpResponse<String> response){return JSON.readTree(response.body()).path("error").path("code").asText();}
    private static String requestId(HttpResponse<String> response){return response.headers().firstValue("X-Request-ID").orElseThrow();}
    private static String id(){return UUID.randomUUID().toString();}
    private record Actor(String id,String app,String client,SessionService.AuthenticationCreated root,SessionService.TokenPair tokens){}
}
