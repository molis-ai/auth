package ai.molis.auth.federation;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.login.*;
import ai.molis.auth.security.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

/** Real Spring MVC/security chain + MySQL/Redis. Mock servlet HTTPS, offline signed provider; not network TLS. */
@SpringBootTest(classes=AuthApplication.class,properties={"auth.login.enabled=true","auth.ephemeral.enabled=true","auth.federation.enabled=true","auth.issuer=https://auth.example.test"})
@AutoConfigureMockMvc
class ProviderHttpRedisIT {
    static final String AUTH="https://auth.example.test",PRODUCT="https://product.example.test",VERIFIER="v".repeat(43);
    static final Map<String,Map<String,Object>> RESPONSES=new ConcurrentHashMap<>();
    static final Map<String,AtomicInteger> CALLS=new ConcurrentHashMap<>();
    @Autowired MockMvc mvc;
    @Autowired LoginCoordinator login;
    @Autowired RedisAuthTransactions auth;
    @Autowired JdbcTemplate jdbc;
    @Autowired ai.molis.auth.session.SessionService sessions;
    @Autowired ai.molis.auth.account.LocalAccountService localAccounts;
    @TestBean(enforceOverride=true) ProviderConfiguration.ProviderClients providerClients;
    String address;
    @BeforeEach void address(){address="2001:db8:"+id().replace("-","").substring(0,24).replaceAll("(.{4})(?=.)","$1:");}
    @AfterEach void clear(){RESPONSES.clear();CALLS.clear();}
    static ProviderConfiguration.ProviderClients providerClients() {
        var clients=new ArrayList<ProviderCodeClient>();Clock clock=Clock.systemUTC();
        for(var provider:IdentityProvider.values()) {
            var registration=new ProviderRegistration(provider,ProviderTestTokens.CLIENT,URI.create(AUTH+"/oauth2/callback/"+provider.name().toLowerCase(Locale.ROOT)));
            clients.add(new ProviderCodeClient(registration,ignored->"test-secret",ProviderTestTokens.verifier(provider,clock),clock,(uri,form)->{
                String code=query(form).get("code");CALLS.computeIfAbsent(code,ignored->new AtomicInteger()).incrementAndGet();
                var claims=RESPONSES.get(code);if(claims==null)throw new AssertionError("Unexpected provider request");
                return new ProviderHttp.Response(200,"application/json",ProviderTestTokens.JSON.writeValueAsBytes(Map.of("id_token",ProviderTestTokens.sign(claims),"access_token","test-provider-access","expires_in",3600,"token_type","Bearer")));
            }));
        }
        return new ProviderConfiguration.ProviderClients(clients);
    }
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
        p.add("spring.data.redis.host",()->"127.0.0.1");p.add("spring.data.redis.port",()->{int port=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));if(port<1024||port>65535||port==6379)throw new IllegalArgumentException("Dedicated Redis required");return port;});
        p.add("spring.data.redis.username",()->"");p.add("spring.data.redis.password",()->"");p.add("spring.data.redis.ssl.enabled",()->false);
        p.add("auth.federation.crypto.keys.primary",()->ProviderStateTests.testKey(1));
    }
    static String id(){return UUID.randomUUID().toString();}
    static String enc(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8);}
    static Map<String,String> query(String query){var map=new HashMap<String,String>();for(String entry:query.split("&")){var pair=entry.split("=",2);map.put(URLDecoder.decode(pair[0],StandardCharsets.UTF_8),URLDecoder.decode(pair[1],StandardCharsets.UTF_8));}return map;}
    MvcResult send(MockHttpServletRequestBuilder request) throws Exception{return mvc.perform(request.secure(true).with(r->{r.setRemoteAddr(address);return r;})).andReturn();}
    String transaction() {
        String application=id(),client="provider-http-"+id(),registered=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Provider HTTP fixture','ACTIVE')",application);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,application);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,PRODUCT+"/callback");
        return login.begin(new LoginController.Begin(client,PRODUCT+"/callback",Pkce.challenge(VERIFIER),"S256",TokenSecrets.generate(),Set.of("account"),false),PRODUCT,address).transaction();
    }
    Fixture begin(IdentityProvider provider) throws Exception {
        String tx=transaction(),name=provider.name().toLowerCase(Locale.ROOT);
        var response=send(post("/api/v1/auth/providers/"+name+"/start").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,tx).contentType("application/json").content("{}"));
        assertThat(response.getResponse().getStatus()).isEqualTo(200);
        String cookie=response.getResponse().getHeader("Set-Cookie");assertThat(cookie).contains("__Host-","Secure","HttpOnly","SameSite=None","Path=/","Max-Age=300").doesNotContain("Domain=");
        String cookiePair=cookie.split(";",2)[0];String binding=cookiePair.split("=",2)[1];
        assertThat(response.getResponse().getContentAsString()).doesNotContain(binding,tx,"test-secret");
        var url=URI.create(ProviderTestTokens.JSON.readTree(response.getResponse().getContentAsString()).path("data").path("authorizationUrl").asString());
        var args=query(url.getRawQuery());String code=TokenSecrets.generate(),email=id()+"@gmail.com";
        RESPONSES.put(code,ProviderTestTokens.claims(provider,id(),email,args.get("nonce"),Clock.systemUTC().instant()));
        return new Fixture(provider,tx,args.get("state"),code,cookiePair,email);
    }
    record Fixture(IdentityProvider provider,String tx,String state,String code,String cookie,String email){}
    @Test void sameEmailPasswordContinuationDoesNotRequireMailDeliveryEnabled()throws Exception {
        var f=begin(IdentityProvider.GOOGLE);
        localAccounts.registerAfterMailboxVerification(id(),f.email(),"Existing fixture","An existing account link password","en",id());
        var result=send(callback(f,form(f)).header("Cookie",f.cookie()));
        assertThat(result.getResponse().getHeader("Location")).isEqualTo(AUTH+"/provider-mailbox#transaction="+f.tx()+"&continuation="+f.state());
        var context=send(post("/api/v1/auth/providers/continuation/context").header("Origin",AUTH).header("Cookie",f.cookie()).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx())
                .contentType("application/json").content(ProviderTestTokens.JSON.writeValueAsString(Map.of("continuation",f.state()))));
        assertThat(context.getResponse().getStatus()).isEqualTo(200);assertThat(context.getResponse().getContentAsString()).contains("LINK_PASSWORD");
    }
    record Binding(Fixture fixture,String user,String grant,String subject){}
    Binding binding(IdentityProvider provider) throws Exception {
        String tx=transaction(),user=id(),subject=id();
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES (?,'Binding fixture','ACTIVE')",user);
        String root=sessions.createAuthentication(user,true).authenticationId();
        String grant=sessions.createGrant(root,auth.read(tx).context().clientId(),Set.of("account"));
        String access=sessions.issueInitial(grant).accessToken();
        String name=provider.name().toLowerCase(Locale.ROOT);
        var response=send(post("/api/v1/auth/providers/"+name+"/bind").header("Origin",AUTH)
                .header(AuthHttpBoundary.TRANSACTION_HEADER,tx).header("Authorization","Bearer "+access).contentType("application/json").content("{}"));
        assertThat(response.getResponse().getStatus()).isEqualTo(200);
        var url=URI.create(ProviderTestTokens.JSON.readTree(response.getResponse().getContentAsString()).path("data").path("authorizationUrl").asString());
        var args=query(url.getRawQuery());String code=TokenSecrets.generate(),email=id()+"@gmail.com";
        RESPONSES.put(code,ProviderTestTokens.claims(provider,subject,email,args.get("nonce"),Clock.systemUTC().instant()));
        return new Binding(new Fixture(provider,tx,args.get("state"),code,response.getResponse().getHeader("Set-Cookie").split(";",2)[0],email),user,grant,subject);
    }
    @Test void explicitBindingAttachesBothProvidersWithoutCreatingMailboxAndCannotReplay() throws Exception {
        for(var provider:IdentityProvider.values()) {
            var b=binding(provider);var f=b.fixture();
            assertThat(send(callback(f,form(f)).header("Cookie",f.cookie())).getResponse().getHeader("Location")).isEqualTo(AUTH+"/complete#transaction="+f.tx());
            assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,b.subject())).isEqualTo(b.user());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",Integer.class,f.email())).isZero();
            error(send(callback(f,form(f)).header("Cookie",f.cookie())),"PROVIDER_TRANSACTION_INVALID");
            assertThat(CALLS.get(f.code()).get()).isEqualTo(1);
        }
    }
    @Test void revokedTargetCannotBeBoundAfterProviderVerification() throws Exception {
        var b=binding(IdentityProvider.GOOGLE);var f=b.fixture();sessions.revokeSession(b.user(),b.grant());
        error(send(callback(f,form(f)).header("Cookie",f.cookie())),"UNAUTHENTICATED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_external_identity WHERE subject=?",Integer.class,b.subject())).isZero();
    }
    @Test void identityOwnedByAnotherAccountCannotBeMoved() throws Exception {
        var b=binding(IdentityProvider.GOOGLE);var f=b.fixture();String other=id();
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES (?,'Other fixture','ACTIVE')",other);
        jdbc.update("INSERT INTO auth_external_identity(id,user_id,provider,issuer,subject) VALUES (?,?,'GOOGLE','https://accounts.google.com',?)",id(),other,b.subject());
        error(send(callback(f,form(f)).header("Cookie",f.cookie())),"IDENTITY_ALREADY_LINKED");
        assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,b.subject())).isEqualTo(other);
    }
    @Test void bindingRejectsUnknownAccessBeforeClaimingTransaction() throws Exception {
        String tx=transaction();
        assertThat(send(post("/api/v1/auth/providers/google/bind").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,tx)
                .header("Authorization","Bearer "+TokenSecrets.generate()).contentType("application/json").content("{}")).getResponse().getStatus()).isEqualTo(401);
        assertThat(auth.read(tx).status()).isEqualTo("READY");
    }
    MockHttpServletRequestBuilder callback(Fixture f,String form) {
        return f.provider()==IdentityProvider.GOOGLE?get("/oauth2/callback/google").with(request->{request.setQueryString(form);return request;})
                :post("/oauth2/callback/apple").header("Origin","https://appleid.apple.com").contentType("application/x-www-form-urlencoded").content(form);
    }
    String form(Fixture f){return "state="+f.state()+"&code="+f.code();}
    void error(MvcResult result,String code) {
        assertThat(result.getResponse().getStatus()).isEqualTo(303);
        assertThat(result.getResponse().getHeader("Location")).isEqualTo(AUTH+"/login#provider-error="+code);
        assertThat(result.getResponse().getHeader("Referrer-Policy")).isEqualTo("no-referrer");
        assertThat(result.getResponse().getHeader("Cache-Control")).contains("no-store");
        assertThat(result.getResponse().getContentAsByteArray()).isEmpty();
    }

    @Test void publicProviderPagesAcceptTopLevelNavigationAndExposeOnlyProviderNames() throws Exception {
        boolean packaged=new org.springframework.core.io.ClassPathResource("static/auth-ui/index.html").exists();
        for(String page:List.of("/provider","/login")) {
            var response=send(get(page).header("Sec-Fetch-Site","cross-site").header("Sec-Fetch-Mode","navigate")
                    .header("Sec-Fetch-Dest","document").header("Origin","null")).getResponse();
            assertThat(response.getStatus()).isEqualTo(packaged?200:503);
            assertThat(response.getHeader("Access-Control-Allow-Origin")).isNull();
            assertThat(response.getHeader("Content-Security-Policy")).contains("frame-ancestors 'none'");
            assertThat(response.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
        }
        var response=send(get("/api/v1/auth/ui-configuration").header("Origin",AUTH)).getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        var providers=ProviderTestTokens.JSON.readTree(response.getContentAsString()).path("data").path("providers");
        assertThat(providers.toString()).isEqualTo("[\"google\",\"apple\"]");
        assertThat(response.getContentAsString()).doesNotContain("test-secret","primary","privateKey","clientSecret");
        var denied=send(get("/api/v1/auth/ui-configuration").header("Sec-Fetch-Site","cross-site")
                .header("Sec-Fetch-Mode","navigate").header("Sec-Fetch-Dest","document")).getResponse();
        assertThat(denied.getStatus()).isEqualTo(403);
        assertThat(send(get("/complete").header("Sec-Fetch-Site","cross-site").header("Sec-Fetch-Mode","navigate")
                .header("Sec-Fetch-Dest","document")).getResponse().getStatus()).isEqualTo(packaged?200:503);
    }
    @Test void googleMvcCallbackFlowsThroughRealSecurityToAuthorizationCodeAndToken() throws Exception {
        var f=begin(IdentityProvider.GOOGLE);String client=auth.read(f.tx()).context().clientId();
        var callback=send(callback(f,form(f)).header("Cookie",f.cookie()));
        assertThat(callback.getResponse().getHeader("Location")).isEqualTo(AUTH+"/complete#transaction="+f.tx());
        assertThat(callback.getResponse().getHeader("Set-Cookie")).contains("Max-Age=0");
        var preview=send(post("/api/v1/auth/transactions/confirmation").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json").content("{}"));
        assertThat(preview.getResponse().getStatus()).isEqualTo(200);
        String proof=ProviderTestTokens.JSON.readTree(preview.getResponse().getContentAsString()).path("data").path("confirmation").asString();
        String binding=preview.getResponse().getHeader("Set-Cookie").split(";",2)[0];
        var completed=send(post("/api/v1/auth/transactions/complete").header("Origin",AUTH).header("Cookie",binding).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json")
                .content(ProviderTestTokens.JSON.writeValueAsString(Map.of("confirmation",proof,"confirmed",true))));
        assertThat(completed.getResponse().getStatus()).isEqualTo(200);
        String redirect=ProviderTestTokens.JSON.readTree(completed.getResponse().getContentAsString()).path("data").path("redirectTo").asString();
        String code=query(URI.create(redirect).getRawQuery()).get("code");
        var tokens=send(post("/oauth2/token").header("Origin",PRODUCT).contentType("application/x-www-form-urlencoded").content("grant_type=authorization_code&client_id="+enc(client)+"&redirect_uri="+enc(PRODUCT+"/callback")+"&code_verifier="+VERIFIER+"&code="+code));
        assertThat(tokens.getResponse().getStatus()).isEqualTo(200);
        assertThat(ProviderTestTokens.JSON.readTree(tokens.getResponse().getContentAsString()).path("access_token").asString()).matches("[A-Za-z0-9_-]{43}");
        error(send(callback(f,form(f)).header("Cookie",f.cookie())),"PROVIDER_TRANSACTION_INVALID");assertThat(CALLS.get(f.code()).get()).isEqualTo(1);
    }

    @Test void appleCrossSiteFormUsesCookieButUnsignedUserAndIdTokenCannotOverrideIdentity() throws Exception {
        var f=begin(IdentityProvider.APPLE);
        var result=send(callback(f,form(f)+"&user="+enc("{\"email\":\"attacker@example.test\",\"name\":{\"firstName\":\"Injected\"}}")+"&id_token=unsigned-ignored").header("Cookie",f.cookie()).header("Sec-Fetch-Site","cross-site"));
        assertThat(result.getResponse().getHeader("Location")).isEqualTo(AUTH+"/complete#transaction="+f.tx());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",Integer.class,f.email())).isEqualTo(1);
        assertThat(result.getResponse().getHeader("Access-Control-Allow-Origin")).isNull();
    }

    @Test void missingWrongAndDuplicateBindingCookiesCannotConsumeValidState() throws Exception {
        var f=begin(IdentityProvider.GOOGLE);
        error(send(callback(f,form(f))),"PROVIDER_TRANSACTION_INVALID");
        error(send(callback(f,form(f)).header("Cookie",ProviderHttpBoundary.cookieName(f.state())+"="+TokenSecrets.generate())),"PROVIDER_TRANSACTION_INVALID");
        error(send(callback(f,form(f)).header("Cookie",f.cookie()+"; "+f.cookie())),"INVALID_REQUEST");
        assertThat(CALLS).doesNotContainKey(f.code());
        assertThat(send(callback(f,form(f)).header("Cookie",f.cookie())).getResponse().getHeader("Location")).contains("/complete#transaction=");
    }

    @Test void duplicateUnknownAndMalformedEncodedFieldsFailBeforeProviderExchange() throws Exception {
        for(var provider:IdentityProvider.values()) {
            var f=begin(provider);
            for(String extra:List.of("&state="+f.state(),"&%73tate="+f.state(),"&emailVerified=true","&error=access_denied","&error_description=%C0%AF","&error_description=%QZ","&error_description=%４１","&iss=https%3A%2F%2Fattacker.example.test"))
                error(send(callback(f,form(f)+extra).header("Cookie",f.cookie())),"INVALID_REQUEST");
            assertThat(CALLS).doesNotContainKey(f.code());
        }
    }

    @Test void appleRequiresFormPostWithoutQueryAndRejectsUnrelatedOrigin() throws Exception {
        var f=begin(IdentityProvider.APPLE);
        error(send(post("/oauth2/callback/apple").header("Cookie",f.cookie()).header("Origin",PRODUCT).contentType("application/x-www-form-urlencoded").content(form(f))),"ORIGIN_NOT_ALLOWED");
        for(String type:List.of("application/json","application/x-www-form-urlencoded;charset=unsupported-charset","application/x-www-form-urlencoded;charset=ISO-8859-1"))
            error(send(post("/oauth2/callback/apple").header("Cookie",f.cookie()).contentType(type).content("{}")),"FORM_REQUIRED");
        error(send(post(URI.create("/oauth2/callback/apple?state="+f.state())).header("Cookie",f.cookie()).contentType("application/x-www-form-urlencoded").content(form(f))),"INVALID_REQUEST");
        error(send(get(URI.create("/oauth2/callback/apple?"+form(f))).header("Cookie",f.cookie())),"INVALID_REQUEST");
        assertThat(CALLS).doesNotContainKey(f.code());
    }

    @Test void cancellationClearsCookieAndRedirectsToSafeErrorWithoutEchoingProviderText() throws Exception {
        var f=begin(IdentityProvider.APPLE);
        var result=send(callback(f,"state="+f.state()+"&error=access_denied&error_description="+enc("<script>private</script>")).header("Cookie",f.cookie()));
        error(result,"PROVIDER_CANCELLED");assertThat(result.getResponse().getHeader("Set-Cookie")).contains("Max-Age=0");
        assertThatThrownBy(()->auth.read(f.tx())).hasMessage("INVALID_TRANSACTION");assertThat(CALLS).doesNotContainKey(f.code());
    }

    @Test void insecureCallbacksAndOversizedBodiesAreRejected() throws Exception {
        var f=begin(IdentityProvider.APPLE);
        error(mvc.perform(callback(f,form(f)).header("Cookie",f.cookie()).secure(false)).andReturn(),"HTTPS_REQUIRED");
        error(send(callback(f,"x="+"x".repeat(32768)).header("Cookie",f.cookie())),"REQUEST_TOO_LARGE");
        assertThat(CALLS).doesNotContainKey(f.code());
    }

    @Test void startRequiresAuthOriginSingleTransactionHeaderAndEmptyBody() throws Exception {
        String tx=transaction();
        for(String origin:List.of(PRODUCT,"https://appleid.apple.com"))
            assertThat(send(post("/api/v1/auth/providers/google/start").header("Origin",origin).header(AuthHttpBoundary.TRANSACTION_HEADER,tx).contentType("application/json").content("{}")).getResponse().getStatus()).isEqualTo(403);
        assertThat(send(post("/api/v1/auth/providers/google/start").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,tx,tx).contentType("application/json").content("{}")).getResponse().getStatus()).isEqualTo(400);
        assertThat(send(post("/api/v1/auth/providers/google/start").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,tx).contentType("application/json").content("{\"userId\":\"injected\"}")).getResponse().getStatus()).isEqualTo(400);
        assertThat(auth.read(tx).status()).isEqualTo("READY");
    }

    @Test void providerOriginDoesNotRelaxFirstPartyPasswordEndpoint() throws Exception {
        var result=send(post("/api/v1/auth/transactions/password").header("Origin","https://appleid.apple.com").header(AuthHttpBoundary.TRANSACTION_HEADER,transaction()).contentType("application/json").content("{}"));
        assertThat(result.getResponse().getStatus()).isEqualTo(403);assertThat(result.getResponse().getHeader("Location")).isNull();
    }

    @Test void pendingBrowserCookiesAreBoundedBeforeClaimingAnotherTransaction() throws Exception {
        String tx=transaction();var cookies=new ArrayList<String>();
        for(int i=0;i<5;i++)cookies.add(ProviderHttpBoundary.cookieName(TokenSecrets.generate())+"="+TokenSecrets.generate());
        var result=send(post("/api/v1/auth/providers/google/start").header("Origin",AUTH).header("Cookie",String.join("; ",cookies))
                .header(AuthHttpBoundary.TRANSACTION_HEADER,tx).contentType("application/json").content("{}"));
        assertThat(result.getResponse().getStatus()).isEqualTo(429);
        assertThat(result.getResponse().getContentAsString()).contains("PROVIDER_TOO_MANY_PENDING");
        assertThat(auth.read(tx).status()).isEqualTo("READY");
    }

    @Test void callbackRateLimitRunsBeforeProviderExchange() throws Exception {
        var f=begin(IdentityProvider.GOOGLE);
        for(int i=0;i<60;i++)error(send(callback(f,form(f))),"PROVIDER_TRANSACTION_INVALID");
        var limited=send(callback(f,form(f)).header("Cookie",f.cookie()));
        error(limited,"RATE_LIMITED");assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
        assertThat(CALLS).doesNotContainKey(f.code());assertThat(auth.read(f.tx()).status()).isEqualTo("BUSY");
    }
}
