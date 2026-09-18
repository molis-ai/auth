package ai.molis.auth.contract;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.authorization.AuthorizationMapper;
import ai.molis.auth.client.*;
import ai.molis.auth.service.ServiceIdentityService;
import ai.molis.auth.session.SessionService;
import ai.molis.example.auth.DemoApplication;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static ai.molis.auth.client.AuthFailure.Kind.*;

/** Compiled independent client and business example call real Auth HTTP; separate MySQL schemas, no fake Allow. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"auth.login.enabled=false","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080","molis.auth.enabled=false"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class JavaSdkHttpIT {
    @org.springframework.test.context.bean.override.mockito.MockitoBean ai.molis.auth.verification.RedisRateLimiter limiter;
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired ServiceIdentityService services;
    @Autowired org.mybatis.spring.SqlSessionTemplate sql;
    @MockitoSpyBean AuthorizationMapper mapper;
    static final JsonMapper JSON=JsonMapper.builder().build();
    static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    @AfterAll static void close(){HTTP.close();}
    @DynamicPropertySource static void properties(DynamicPropertyRegistry p){p.add("spring.datasource.url",JavaSdkHttpIT::jdbcUrl);p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));}
    static String jdbcUrl(){String value=System.getProperty("auth.it.jdbc-url","");if(!value.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Isolated test database required");return value;}
    AuthOptions options(){return new AuthOptions(URI.create("http://127.0.0.1:"+port),true,Duration.ofSeconds(3),Duration.ofSeconds(5));}
    @Test void realClientCredentialsDecisionsActionsAndAuditAreConnected(){var f=fixture();try(var wire=new JdkAuthTransport(options())){var client=client(f,wire);
        var decision=client.requireAllowed(f.token(),f.space(),"project.read",new AuthorizationClient.Resource("project","sdk-contract-project"));
        assertThat(decision.requestId()).isNotBlank();assertThat(jdbc.queryForObject("SELECT outcome FROM auth_audit_event WHERE decision_id=?",String.class,decision.decisionId())).isEqualTo("SUCCESS");
        assertThat(client.allowedActions(f.token(),f.space()).allowedActions()).contains("project.update");
        assertThat(client.authorizedSpaceIds(f.token(),"project.read",1000)).containsExactly(f.space());
        assertThat(tokenCount(f)).isEqualTo(1);
        jdbc.update("UPDATE auth_membership SET role='VIEWER' WHERE space_id=? AND user_id=?",f.space(),f.user());
        assertThat(client.check(f.token(),f.space(),"project.update",null).allowed()).isFalse();
        assertThat(client.check(f.token(),f.space(),"project.read",null).allowed()).isTrue();
    }}
    @Test void revokedUserAndMismatchedAppDoNotReusePreviousAllow(){var f=fixture();var other=fixture();try(var wire=new JdkAuthTransport(options())){var client=client(f,wire);
        assertKind(FORBIDDEN,()->client.check(other.token(),f.space(),"project.read",null));
        client.requireAllowed(f.token(),f.space(),"project.read",null);sessions.revokeAll(f.user());assertKind(USER_UNAUTHENTICATED,()->client.check(f.token(),f.space(),"project.read",null));
    }}
    @Test void serviceRotationRequiresFreshCredentialAndNeverRetriesTheFailedDecision(){var f=fixture();var credentials=new AtomicReference<>(new ServiceCredentials(f.service().clientId(),f.service().secret()));
        try(var wire=new JdkAuthTransport(options())){var client=new HttpAuthorizationClient(options(),credentials::get,wire);client.requireAllowed(f.token(),f.space(),"project.read",null);
            var rotated=services.rotate(f.service().clientId(),f.owner(),id());credentials.set(new ServiceCredentials(f.service().clientId(),rotated.secret()));
            assertKind(SERVICE_UNAUTHENTICATED,()->client.check(f.token(),f.space(),"project.read",null));
            assertThat(tokenCount(f)).isEqualTo(1);
            client.requireAllowed(f.token(),f.space(),"project.read",null);
            assertThat(tokenCount(f)).isEqualTo(2);
            services.disable(f.service().clientId(),f.owner(),id());assertKind(SERVICE_UNAUTHENTICATED,()->client.check(f.token(),f.space(),"project.read",null));
            assertKind(SERVICE_UNAUTHENTICATED,()->client.check(f.token(),f.space(),"project.read",null));
        }}
    @Test void actualScopeCrossesTwoHundredAndNeverReturnsPartialWhenBoundIsExceeded(){var f=fixture();var expected=new TreeSet<String>();expected.add(f.space());
        for(int i=0;i<200;i++){String space=id();expected.add(space);jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'SDK page fixture','TEAM','ACTIVE')",space);
            jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,'OWNER')",space,f.user());}
        try(var wire=new JdkAuthTransport(options())){var client=client(f,wire);assertThat(client.authorizedSpaceIds(f.token(),"project.read",300)).containsExactlyElementsOf(expected);
            assertKind(SCOPE_TOO_LARGE,()->client.authorizedSpaceIds(f.token(),"project.read",200));}
    }
    @Test void auditFailureRemainsAnOutageNotAnAllowOrOrdinaryDeny(){var f=fixture();try(var wire=new JdkAuthTransport(options())){var client=client(f,wire);client.requireAllowed(f.token(),f.space(),"project.read",null);
        doThrow(new DataAccessResourceFailureException("private database message")).when(mapper).audit(any());
        assertKind(UNAVAILABLE,()->client.check(f.token(),f.space(),"project.read",null));
    }}
    @Test void independentBusinessHttpUsesTrustedOwnershipSqlScopeAndExecutionRechecks()throws Exception{
        var f=fixture();var unrelated=fixture();String db="demo_test_"+id().replace("-","");jdbc.execute("CREATE DATABASE "+db);
        String url=jdbcUrl().replaceFirst("/auth_test_[A-Za-z0-9_]+", "/"+db);
        try(var demo=new SpringApplicationBuilder(DemoApplication.class).run("--spring.config.name=demo","--server.address=127.0.0.1","--server.port=0",
                "--spring.datasource.url="+url,"--spring.datasource.username="+System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"),"--spring.datasource.password="+System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""),
                "--molis.auth.enabled=true","--molis.auth.issuer=http://127.0.0.1:"+port,"--molis.auth.allow-loopback-http=true","--demo.allow-loopback-http=true",
                "--molis.auth.client-id="+f.service().clientId(),"--molis.auth.client-secret="+f.service().secret())){
            assertThat(demo.getBeansOfType(org.springframework.security.core.userdetails.UserDetailsService.class)).isEmpty();
            var business=new JdbcTemplate(demo.getBean(DataSource.class));String hidden="00000000-0000-0000-0000-000000000001",editable="00000000-0000-0000-0000-000000000002",locked="00000000-0000-0000-0000-000000000003";
            business.update("INSERT INTO demo_project(id,space_id,name,state) VALUES(?,?,'Hidden','EDITABLE'),(?,?,'Visible','EDITABLE'),(?,?,'Locked','LOCKED')",hidden,unrelated.space(),editable,f.space(),locked,f.space());
            int demoPort=Integer.parseInt(demo.getEnvironment().getProperty("local.server.port"));
            var first=send(demoPort,f.token(),"GET","?limit=1",null);assertThat(first.statusCode()).isEqualTo(200);var page=JSON.readTree(first.body());
            assertThat(page.path("total").asInt()).isEqualTo(2);assertThat(page.path("items").get(0).path("id").asText()).isEqualTo(editable);assertThat(page.path("nextCursor").asText()).isEqualTo(editable);assertThat(first.body()).doesNotContain("Hidden");
            var second=send(demoPort,f.token(),"GET","?limit=1&cursor="+editable,null);assertThat(JSON.readTree(second.body()).path("items").get(0).path("id").asText()).isEqualTo(locked);
            assertThat(send(demoPort,f.token(),"GET","/"+hidden,null).statusCode()).isEqualTo(403);
            assertThat(send(demoPort,"x".repeat(43),"GET","/"+id(),null).statusCode()).isEqualTo(401);
            assertThat(send(demoPort,f.token(),"GET","/"+id(),null).statusCode()).isEqualTo(404);
            assertThat(send(demoPort,f.token(),"GET","/"+editable+"?spaceId="+f.space(),null).statusCode()).isEqualTo(400);
            assertThat(send(demoPort,f.token(),"PUT","/"+editable,Map.of("name","Forged","version",0,"spaceId",unrelated.space())).statusCode()).isEqualTo(400);
            assertThat(send(demoPort,f.token(),"PUT","/"+editable,Map.of("name","Renamed","version",0)).statusCode()).isEqualTo(200);
            assertThat(business.queryForObject("SELECT name FROM demo_project WHERE id=?",String.class,editable)).isEqualTo("Renamed");
            assertThat(send(demoPort,f.token(),"PUT","/"+locked,Map.of("name","Blocked","version",0)).statusCode()).isEqualTo(409);
            var actions=send(demoPort,f.token(),"GET","/"+editable+"/actions",null);assertThat(actions.statusCode()).isEqualTo(200);assertThat(actions.body()).contains("project.update");
            jdbc.update("UPDATE auth_membership SET role='VIEWER' WHERE space_id=? AND user_id=?",f.space(),f.user());
            assertThat(send(demoPort,f.token(),"PUT","/"+editable,Map.of("name","Must not write","version",1)).statusCode()).isEqualTo(403);
            assertThat(business.queryForObject("SELECT version FROM demo_project WHERE id=?",Long.class,editable)).isEqualTo(1L);
            doThrow(new DataAccessResourceFailureException("private outage")).when(mapper).audit(any());
            assertThat(send(demoPort,f.token(),"GET","/"+editable,null).statusCode()).isEqualTo(503);
            doAnswer(invocation->sql.getMapper(AuthorizationMapper.class).audit(invocation.getArgument(0))).when(mapper).audit(any());
            services.disable(f.service().clientId(),f.owner(),id());assertThat(send(demoPort,f.token(),"GET","/"+editable,null).statusCode()).isEqualTo(503);
            assertThat(send(demoPort,null,"GET","/"+editable,null).statusCode()).isEqualTo(401);
            assertThat(business.queryForObject("SELECT name FROM demo_project WHERE id=?",String.class,editable)).isEqualTo("Renamed");
        }
    }
    private int tokenCount(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM auth_service_token t JOIN auth_service_credential c ON c.id=t.credential_id WHERE c.service_client_id=?",Integer.class,f.service().id());}
    private HttpAuthorizationClient client(Fixture f,JdkAuthTransport wire){return new HttpAuthorizationClient(options(),()->new ServiceCredentials(f.service().clientId(),f.service().secret()),wire);}
    private void assertKind(AuthFailure.Kind kind,Runnable action){assertThatThrownBy(action::run).isInstanceOfSatisfying(AuthFailure.class,e->assertThat(e.kind()).isEqualTo(kind));}
    private Fixture fixture(){String app=id(),registered=id(),login="java-sdk-"+id(),space=id(),owner=id(),user=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES(?,'Java SDK contract','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(?,?,?,'WEB','ACTIVE','account profile')",registered,login,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES(?,'https://java-sdk.example.test/callback')",registered);
        for(String action:List.of("project.read","project.update","feed.read"))jdbc.update("INSERT INTO auth_application_permission(application_id,action) VALUES(?,?)",app,action);
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES(?,'SDK owner','ACTIVE'),(?,'SDK member','ACTIVE')",owner,user);
        jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'SDK team','TEAM','ACTIVE')",space);
        jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,'OWNER'),(?,?,'MEMBER')",space,owner,space,user);
        var root=sessions.createAuthentication(user,true);var token=sessions.issueInitial(sessions.createGrant(root.authenticationId(),login,Set.of("account")));
        return new Fixture(space,user,owner,token.accessToken(),services.create(app,"SDK backend",owner,id()));
    }
    private HttpResponse<String> send(int port,String token,String method,String suffix,Object body)throws Exception{
        var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/demo/projects"+suffix)).timeout(Duration.ofSeconds(10));
        if(token!=null)request.header("Authorization","Bearer "+token);if(body!=null)request.header("Content-Type","application/json");
        return HTTP.send(request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    static String id(){return UUID.randomUUID().toString();}
    record Fixture(String space,String user,String owner,String token,ServiceIdentityService.Created service){@Override public String toString(){return "Fixture[redacted]";}}
}
