package ai.molis.auth.login;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.security.*;
import ai.molis.auth.session.SessionService;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.*;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

/** Real MVC/security + disposable MySQL/Redis. Browser behavior is separately verified in the UI. */
@SpringBootTest(classes=AuthApplication.class, properties={"auth.login.enabled=true","auth.ephemeral.enabled=true","auth.issuer=https://auth.example.test"})
@AutoConfigureMockMvc
class CompletionHttpRedisIT {
    static final String AUTH="https://auth.example.test", PRODUCT="https://product.example.test", PASSWORD="Completion fixture password 8349!";
    static final JsonMapper JSON=JsonMapper.builder().build();
    @Autowired MockMvc mvc; @Autowired LoginCoordinator login; @Autowired LocalAccountService accounts;
    @Autowired RedisAuthTransactions transactions; @Autowired SessionService sessions;
    @Autowired StringRedisTemplate redis; @Autowired JdbcTemplate jdbc;
    String address;
    @BeforeEach void source(){address="2001:db8:"+id().replace("-","").substring(0,24).replaceAll("(.{4})(?=.)","$1:");}
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
        p.add("spring.data.redis.host",()->"127.0.0.1");p.add("spring.data.redis.port",()->{int port=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));if(port<1024||port>65535||port==6379)throw new IllegalArgumentException("Dedicated Redis required");return port;});
        p.add("spring.data.redis.username",()->"");p.add("spring.data.redis.password",()->"");p.add("spring.data.redis.ssl.enabled",()->false);
    }
    static String id(){return UUID.randomUUID().toString();}
    Fixture fixture() {
        String email=id()+"@example.test",user=accounts.registerAfterMailboxVerification(id(),email,"Confirmation fixture",PASSWORD,"en",id());
        String app=id(),client="confirmation-"+id(),registered=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Confirmation fixture','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,PRODUCT+"/callback");
        String tx=login.begin(new LoginController.Begin(client,PRODUCT+"/callback",Pkce.challenge("v".repeat(43)),"S256",TokenSecrets.generate(),Set.of("account"),true),PRODUCT,address).transaction();
        login.password(tx,email,PASSWORD,PRODUCT,address,id());
        return new Fixture(tx,user,email,client,transactions.preview(tx).root());
    }
    record Fixture(String tx,String user,String email,String client,String root){}
    record Prepared(String cookie,String proof){}
    String key(Fixture f){return "auth:v1:transaction:"+TokenSecrets.digest(f.tx());}
    MvcResult send(String suffix,Fixture f,Object body,String cookie,String origin)throws Exception {
        var request=post("/api/v1/auth/transactions"+suffix).secure(true).with(r->{r.setRemoteAddr(address);return r;})
                .header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json").content(JSON.writeValueAsString(body));
        if(cookie!=null)request.header("Cookie",cookie);if(origin!=null)request.header("Origin",origin);
        return mvc.perform(request).andReturn();
    }
    Prepared prepare(Fixture f)throws Exception {
        var response=send("/confirmation",f,Map.of(),null,AUTH).getResponse();assertThat(response.getStatus()).isEqualTo(200);
        return new Prepared(response.getHeader("Set-Cookie").split(";",2)[0],JSON.readTree(response.getContentAsString()).path("data").path("confirmation").asString());
    }
    Map<String,Object> confirmed(Prepared p){return Map.of("confirmation",p.proof(),"confirmed",true);}
    int grants(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM auth_authorization_session WHERE authentication_id=?",Integer.class,f.root());}
    @Test void previewShowsVerifiedIdentityButIssuesNoAuthenticationCookieCodeOrGrant()throws Exception {
        var f=fixture();long ttl=redis.getExpire(key(f),TimeUnit.MILLISECONDS);
        var response=send("/confirmation",f,Map.of(),null,AUTH).getResponse();assertThat(response.getStatus()).isEqualTo(200);
        var data=JSON.readTree(response.getContentAsString()).path("data");
        assertThat(data.path("account").path("userId").asString()).isEqualTo(f.user());
        assertThat(data.path("account").path("emails").get(0).asString()).isEqualTo(f.email());
        String cookie=response.getHeader("Set-Cookie"),binding=cookie.split(";",2)[0].split("=",2)[1];
        assertThat(cookie).startsWith("__Host-auth_confirm_").contains("HttpOnly","Secure","SameSite=Strict","Path=/").doesNotContain("Domain=");
        assertThat(response.getContentAsString()).doesNotContain(binding,f.tx(),"access_token","redirectTo");
        assertThat(redis.opsForHash().entries(key(f)).toString()).doesNotContain(binding,data.path("confirmation").asString());
        assertThat(redis.getExpire(key(f),TimeUnit.MILLISECONDS)).isPositive().isLessThanOrEqualTo(ttl);
        assertThat(grants(f)).isZero();assertThat(jdbc.queryForObject("SELECT cookie_hash FROM auth_authentication_session WHERE id=?",String.class,f.root())).isNull();
    }
    @Test void completionRequiresExplicitConsentProofAndMatchingBrowserWithoutConsumingOnBadInput()throws Exception {
        var f=fixture();var p=prepare(f);
        for(var body:List.of(Map.of(),Map.of("confirmation",p.proof()),Map.of("confirmation",p.proof(),"confirmed",false)))
            assertThat(send("/complete",f,body,p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",f,confirmed(p),null,AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",f,confirmed(p),p.cookie().split("=",2)[0]+"="+TokenSecrets.generate(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",f,Map.of("confirmation",TokenSecrets.generate(),"confirmed",true),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(grants(f)).isZero();assertThat(send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(200);
        assertThat(grants(f)).isEqualTo(1);
    }
    @Test void anotherBrowserCannotRebindAndSameBrowserRotationInvalidatesOldPageProof()throws Exception {
        var f=fixture();var p=prepare(f);
        assertThat(send("/confirmation",f,Map.of(),null,AUTH).getResponse().getStatus()).isEqualTo(400);
        var refreshed=send("/confirmation",f,Map.of(),p.cookie(),AUTH).getResponse();assertThat(refreshed.getStatus()).isEqualTo(200);
        String proof=JSON.readTree(refreshed.getContentAsString()).path("data").path("confirmation").asString();
        assertThat(proof).isNotEqualTo(p.proof());assertThat(refreshed.getHeader("Set-Cookie")).startsWith(p.cookie()+";");
        assertThat(send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",f,Map.of("confirmation",proof,"confirmed",true),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(200);
    }
    @Test void confirmationCannotBeTransplantedAcrossTransactionsOrDuplicatedCookies()throws Exception {
        var a=fixture();var b=fixture();var first=prepare(a);var second=prepare(b);
        assertThat(send("/complete",b,confirmed(first),second.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",a,confirmed(first),first.cookie()+"; "+first.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
        assertThat(send("/complete",a,confirmed(first),first.cookie(),AUTH).getResponse().getStatus()).isEqualTo(200);
        assertThat(grants(b)).isZero();
    }
    @Test void concurrentConfirmationsIssueExactlyOneGrantAndReplayCannotSetAnotherCookie()throws Exception {
        var f=fixture();var p=prepare(f);var start=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            var a=executor.submit(()->{start.await();return send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus();});
            var b=executor.submit(()->{start.await();return send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus();});
            start.countDown();assertThat(List.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,400);
        }
        var replay=send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse();assertThat(replay.getStatus()).isEqualTo(400);assertThat(replay.getHeader("Set-Cookie")).isNull();assertThat(grants(f)).isEqualTo(1);
    }
    @Test void cancellationConsumesOnlyThisFlowAndPreservesExistingBrowserAuthentication()throws Exception {
        var f=fixture();var existing=sessions.createAuthentication(f.user(),true);var p=prepare(f);
        var response=send("/cancel",f,Map.of("confirmation",p.proof()),p.cookie()+"; __Host-auth_session="+existing.cookieSecret(),AUTH).getResponse();
        assertThat(response.getStatus()).isEqualTo(200);assertThat(response.getContentAsString()).contains("\"cancelled\":true");
        assertThat(response.getHeader("Set-Cookie")).startsWith("__Host-auth_confirm_").contains("Max-Age=0");
        assertThat(sessions.resolveBrowserAuthentication(existing.cookieSecret())).contains(existing.authenticationId());
        assertThat(grants(f)).isZero();assertThat(send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);
    }
    @Test void disabledAccountOrClientAfterPreviewCannotComplete()throws Exception {
        for(String target:List.of("user","client")) {
            var f=fixture();var p=prepare(f);
            if(target.equals("user"))jdbc.update("UPDATE auth_user SET status='DISABLED' WHERE id=?",f.user());
            else jdbc.update("UPDATE auth_login_client SET status='DISABLED' WHERE client_id=?",f.client());
            assertThat(send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);assertThat(grants(f)).isZero();
        }
    }
    @Test void expiredOrMissingTtlProofCannotComplete()throws Exception {
        for(String expiry:List.of("persistent","expired","extended")) {
            var f=fixture();var p=prepare(f);
            if(expiry.equals("persistent"))redis.persist(key(f));
            else redis.expire(key(f),expiry.equals("expired")?Duration.ZERO:Duration.ofMinutes(11));
            assertThat(send("/complete",f,confirmed(p),p.cookie(),AUTH).getResponse().getStatus()).isEqualTo(400);assertThat(grants(f)).isZero();
        }
    }
    @Test void productOriginMissingOriginAndUnsolicitedBodiesCannotPrepareOrConfirm()throws Exception {
        var f=fixture();
        for(String origin:Arrays.asList(PRODUCT,null,"null"))assertThat(send("/confirmation",f,Map.of(),null,origin).getResponse().getStatus()).isEqualTo(403);
        assertThat(send("/confirmation",f,Map.of("userId",f.user()),null,AUTH).getResponse().getStatus()).isEqualTo(400);
        var p=prepare(f);
        assertThat(send("/complete",f,confirmed(p),p.cookie(),PRODUCT).getResponse().getStatus()).isEqualTo(403);
        assertThat(send("/cancel",f,Map.of("confirmation",p.proof()),p.cookie(),null).getResponse().getStatus()).isEqualTo(403);
        assertThat(grants(f)).isZero();
    }
    @Test void tooManyPendingCookiesRejectsBeforeBindingANewTransaction()throws Exception {
        var f=fixture();var cookies=new ArrayList<String>();
        for(int i=0;i<5;i++)cookies.add("__Host-auth_confirm_"+TokenSecrets.digest(TokenSecrets.generate())+"="+TokenSecrets.generate());
        assertThat(send("/confirmation",f,Map.of(),String.join("; ",cookies),AUTH).getResponse().getStatus()).isEqualTo(429);
        assertThat(redis.opsForHash().get(key(f),"completion-browser")).isNull();
    }
}
