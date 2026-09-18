package ai.molis.auth.federation;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.LocalAccountService;
import ai.molis.auth.login.*;
import ai.molis.auth.security.*;
import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.RedisRateLimiter;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.support.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Production orchestration, real MySQL/Redis and RSA verification. Only provider transport is a test fixture. */
@SpringBootTest(classes=AuthApplication.class, properties={"auth.login.enabled=true", "auth.ephemeral.enabled=true", "auth.issuer=https://auth.example.test"})
class ProviderLoginRedisIT {
    static final String AUTH="https://auth.example.test", PRODUCT="https://product.example.test", VERIFIER="v".repeat(43);
    @Autowired ExternalAccountService accounts;
    @Autowired LocalAccountService local;
    @Autowired LoginCoordinator login;
    @Autowired LoginClientPolicy policy;
    @Autowired RedisRateLimiter limiter;
    @Autowired SessionService sessions;
    @Autowired StringRedisTemplate redis;
    @Autowired JdbcTemplate jdbc;
    @Autowired Clock clock;
    @MockitoSpyBean RedisAuthTransactions auth;
    private final List<ProviderCodeClient> clients=new ArrayList<>();
    private final List<String> keys=new ArrayList<>();
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
        p.add("spring.data.redis.host",()->"127.0.0.1");
        p.add("spring.data.redis.port",()->{int port=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));if(port<1024||port>65535||port==6379)throw new IllegalArgumentException("Dedicated Redis required");return port;});
        p.add("spring.data.redis.username",()->"");p.add("spring.data.redis.password",()->"");p.add("spring.data.redis.ssl.enabled",()->false);
    }
    @AfterEach void cleanup(){clients.forEach(ProviderCodeClient::close);if(!keys.isEmpty())redis.delete(keys);}
    static String id(){return UUID.randomUUID().toString();}
    static Map<String,String> query(URI uri){var values=new HashMap<String,String>();for(String part:uri.getRawQuery().split("&")){var pair=part.split("=",2);values.put(URLDecoder.decode(pair[0],StandardCharsets.UTF_8),URLDecoder.decode(pair[1],StandardCharsets.UTF_8));}return values;}
    private String authKey(String tx){return "auth:v1:transaction:"+TokenSecrets.digest(tx);}
    private int count(String sql,Object... args){return jdbc.queryForObject(sql,Integer.class,args);}

    private Fixture fixture(IdentityProvider provider) {
        var f=new Fixture();f.provider=provider;f.application=id();f.client="provider-it-"+id();f.subject=id();f.email=id()+"@gmail.com";
        String registered=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Provider coordinator fixture','ACTIVE')",f.application);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,f.client,f.application);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,PRODUCT+"/callback");
        f.transaction=login.begin(new LoginController.Begin(f.client,PRODUCT+"/callback",Pkce.challenge(VERIFIER),"S256",TokenSecrets.generate(),Set.of("account"),false),PRODUCT,id()).transaction();
        keys.add(authKey(f.transaction));
        var registration=new ProviderRegistration(provider,ProviderTestTokens.CLIENT,URI.create(AUTH+"/callback/"+provider.name().toLowerCase(Locale.ROOT)));
        var client=new ProviderCodeClient(registration,ignored->"test-client-secret",ProviderTestTokens.verifier(provider,clock),clock,(uri,form)->{
            f.exchanges.incrementAndGet();f.duringExchange.run();
            String nonce=query(f.started.authorizationUrl()).get("nonce");
            String jwt=ProviderTestTokens.sign(ProviderTestTokens.claims(provider,f.subject,f.email,nonce,clock.instant()));
            var response=Map.of("token_type","Bearer","access_token","test-provider-access","id_token",jwt,"expires_in",3600);
            return new ProviderHttp.Response(200,"application/json",ProviderTestTokens.JSON.writeValueAsBytes(response));
        });clients.add(client);
        var states=new RedisProviderTransactions(redis,ProviderStateTests.cipher(),clock,"auth_test:provider-login:"+id()+":");
        f.coordinator=new ProviderLoginCoordinator(List.of(client),states,auth,policy,limiter,accounts);
        f.started=f.coordinator.begin(provider,f.transaction,AUTH,id());keys.add(states.key(f.started.state()));
        return f;
    }
    private ProviderLoginCoordinator.Finished callback(Fixture f){return f.coordinator.callback(f.provider,f.started.state(),f.started.browserBinding(),"test-code",null,"en",id());}
    private static class Fixture {
        IdentityProvider provider;String application,client,transaction,subject,email;ProviderLoginCoordinator coordinator;
        ProviderLoginCoordinator.Started started;AtomicInteger exchanges=new AtomicInteger();Runnable duringExchange=()->{};
    }

    @Test void googleCallbackCompletesRealAuthCodeAndApplicationTokensWithoutPreseededUser() {
        var f=fixture(IdentityProvider.GOOGLE);
        assertThat(auth.read(f.transaction).status()).isEqualTo("BUSY");
        assertThat(callback(f).continueUrl()).isEqualTo(AUTH+"/complete#transaction="+f.transaction);
        assertThat(auth.read(f.transaction).status()).isEqualTo("AUTHENTICATED");
        var completed=login.complete(f.transaction,AUTH);
        var token=sessions.exchangeCode(f.client,query(URI.create(completed.redirectTo())).get("code"),PRODUCT+"/callback",VERIFIER);
        assertThat(sessions.resolveAccessForApplication(token.accessToken(),f.application)).isPresent();
        assertThat(completed.cookieSecret()).isNotNull();
        assertThat(count("SELECT COUNT(*) FROM auth_local_credential c JOIN auth_user_email e ON e.user_id=c.user_id WHERE e.canonical_email=?",f.email)).isZero();
        assertThatThrownBy(()->callback(f)).hasMessage("PROVIDER_TRANSACTION_INVALID");assertThat(f.exchanges.get()).isEqualTo(1);
    }

    @Test void appleCallbackUsesSameAuthHandoffAndIgnoresUnsignedName() {
        var f=fixture(IdentityProvider.APPLE);f.email=id()+"@privaterelay.appleid.com";
        assertThat(query(f.started.authorizationUrl())).containsEntry("response_mode","form_post").doesNotContainKey("code_challenge");
        callback(f);assertThat(auth.consume(f.transaction).root()).isNotBlank();
        assertThat(jdbc.queryForObject("SELECT u.display_name FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE e.canonical_email=?",String.class,f.email)).isEqualTo("Apple user");
    }

    @Test void cancellationAndMalformedCallbackCloseOnlyTheirClaimWithoutProviderExchange() {
        for(int mode=0;mode<3;mode++) {
            var f=fixture(IdentityProvider.GOOGLE);String code=mode==0?null:"test-code",error=mode==2?null:"access_denied";
            if(mode==2) code=null;
            String callbackCode=code;
            assertThatThrownBy(()->f.coordinator.callback(f.provider,f.started.state(),f.started.browserBinding(),callbackCode,error,"en",id()))
                    .hasMessage(mode==0?"PROVIDER_CANCELLED":"PROVIDER_RESPONSE_INVALID");
            assertThatThrownBy(()->auth.read(f.transaction)).isInstanceOf(LoginFailure.class);
            assertThat(f.exchanges.get()).isZero();
        }
    }

    @Test void wrongBrowserDoesNotConsumeLegitimateClaimAndOldOwnerCannotAuthenticate() {
        var f=fixture(IdentityProvider.GOOGLE);
        assertThatThrownBy(()->f.coordinator.callback(f.provider,f.started.state(),TokenSecrets.generate(),"test-code",null,"en",id())).hasMessage("PROVIDER_TRANSACTION_INVALID");
        assertThat(f.exchanges.get()).isZero();callback(f);
        var other=fixture(IdentityProvider.GOOGLE);
        redis.opsForHash().put(authKey(other.transaction),"owner",id());
        assertThatThrownBy(()->callback(other)).hasMessage("INVALID_TRANSACTION");assertThat(other.exchanges.get()).isZero();
        assertThat(auth.read(other.transaction).status()).isEqualTo("BUSY");
    }

    @RepeatedTest(3) void duplicateCallbacksHaveOneExchangeAndOneRoot() throws Exception {
        var f=fixture(IdentityProvider.GOOGLE);var start=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            Callable<Boolean> task=()->{start.await();try{callback(f);return true;}catch(ExternalFailure failure){assertThat(failure).hasMessage("PROVIDER_TRANSACTION_INVALID");return false;}};
            var a=executor.submit(task);var b=executor.submit(task);start.countDown();
            assertThat(List.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(f.exchanges.get()).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session s JOIN auth_user_email e ON e.user_id=s.user_id WHERE e.canonical_email=?",f.email)).isEqualTo(1);
    }

    @Test void applicationDisableIsRecheckedBeforeAndAfterProviderExchange() {
        for(boolean during:List.of(false,true)) {
            var f=fixture(IdentityProvider.GOOGLE);Runnable disable=()->jdbc.update("UPDATE auth_application SET status='DISABLED' WHERE id=?",f.application);
            if(during)f.duringExchange=disable;else disable.run();
            assertThatThrownBy(()->callback(f)).hasMessage("INVALID_CLIENT");assertThat(f.exchanges.get()).isEqualTo(during?1:0);
            assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",f.email)).isZero();
            assertThatThrownBy(()->auth.read(f.transaction)).hasMessage("INVALID_TRANSACTION");
        }
    }

    @Test void providerFailureClosesClaimWithoutRawErrorsOrRetries() {
        var f=fixture(IdentityProvider.GOOGLE);f.duringExchange=()->{throw new IllegalStateException("private-network-and-code");};
        assertThatThrownBy(()->callback(f)).hasMessage("PROVIDER_UNAVAILABLE").hasNoCause();
        assertThatThrownBy(()->auth.read(f.transaction)).hasMessage("INVALID_TRANSACTION");
        assertThatThrownBy(()->callback(f)).hasMessage("PROVIDER_TRANSACTION_INVALID");assertThat(f.exchanges.get()).isEqualTo(1);
    }

    @Test void missingMailboxProofAndExistingAccountCannotBeBypassedByCoordinator() {
        var unknown=fixture(IdentityProvider.GOOGLE);unknown.email=id()+"@example.test";
        assertThatThrownBy(()->callback(unknown)).hasMessage("MAILBOX_VERIFICATION_REQUIRED");
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",unknown.email)).isZero();
        var conflict=fixture(IdentityProvider.GOOGLE);
        local.registerAfterMailboxVerification(id(),conflict.email,"Local account","A secure existing account phrase","en",id());
        assertThatThrownBy(()->callback(conflict)).hasMessage("ACCOUNT_LINK_REQUIRED");
        assertThat(count("SELECT COUNT(*) FROM auth_external_identity WHERE subject=?",conflict.subject)).isZero();
        assertThatThrownBy(()->auth.read(conflict.transaction)).hasMessage("INVALID_TRANSACTION");
    }

    @Test void lostRedisPublicationReplyRollsBackNewAccountAndRoot() {
        var f=fixture(IdentityProvider.GOOGLE);var root=new AtomicReference<String>();
        doAnswer(invocation->{root.set(invocation.getArgument(2));invocation.callRealMethod();throw new LoginFailure(503,"AUTH_UNAVAILABLE");})
                .when(auth).authenticated(eq(f.transaction),anyString(),anyString());
        assertThatThrownBy(()->callback(f)).hasMessage("AUTH_UNAVAILABLE");
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE id=?",root.get())).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",f.email)).isZero();
        assertThat(auth.read(f.transaction).status()).isEqualTo("AUTHENTICATED");
        assertThatThrownBy(()->login.complete(f.transaction,AUTH)).isInstanceOf(SessionService.SessionRejectedException.class);
        assertThat(f.exchanges.get()).isEqualTo(1);
    }

    @Test void databaseCommitFailureAfterPublicationCannotYieldTokens() {
        var f=fixture(IdentityProvider.GOOGLE);
        doAnswer(invocation->{invocation.callRealMethod();TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
            @Override public void beforeCommit(boolean readOnly){throw new IllegalStateException("simulated-commit-boundary-failure");}
        });return null;}).when(auth).authenticated(eq(f.transaction),anyString(),anyString());
        assertThatThrownBy(()->callback(f)).hasMessage("AUTH_UNAVAILABLE").hasNoCause();
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",f.email)).isZero();
        assertThatThrownBy(()->login.complete(f.transaction,AUTH)).isInstanceOf(SessionService.SessionRejectedException.class);
    }

    @Test void failedReturningLoginPreservesExistingIdentityAndOldSessionButRollsBackNewRoot() {
        var f=fixture(IdentityProvider.GOOGLE);
        var proof=ProviderTestTokens.verified(f.provider,f.subject,f.email,TokenSecrets.generate(),clock);
        String oldRoot=accounts.login(proof,"en",id()).authenticationId();
        doThrow(new LoginFailure(503,"AUTH_UNAVAILABLE")).when(auth).authenticated(eq(f.transaction),anyString(),anyString());
        assertThatThrownBy(()->callback(f)).hasMessage("AUTH_UNAVAILABLE");
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session s JOIN auth_user_email e ON e.user_id=s.user_id WHERE e.canonical_email=?",f.email)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE id=? AND revoked_at IS NULL",oldRoot)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_external_identity WHERE subject=?",f.subject)).isEqualTo(1);
        assertThatThrownBy(()->auth.read(f.transaction)).hasMessage("INVALID_TRANSACTION");
    }

    @Test void expiredAuthClaimAfterProviderReplyCannotWriteAccount() {
        var f=fixture(IdentityProvider.GOOGLE);
        f.duringExchange=()->redis.expire(authKey(f.transaction),Duration.ZERO);
        assertThatThrownBy(()->callback(f)).hasMessage("INVALID_TRANSACTION");
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",f.email)).isZero();
        assertThat(f.exchanges.get()).isEqualTo(1);
    }

    @Test void productOriginAndDisabledProviderCannotReuseOutstandingClaim() {
        var f=fixture(IdentityProvider.GOOGLE);
        assertThatThrownBy(()->f.coordinator.begin(f.provider,f.transaction,PRODUCT,id())).hasMessage("AUTH_ORIGIN_REQUIRED");
        assertThatThrownBy(()->f.coordinator.begin(IdentityProvider.APPLE,f.transaction,AUTH,id())).hasMessage("PROVIDER_NOT_ENABLED");
        assertThat(auth.read(f.transaction).status()).isEqualTo("BUSY");
        callback(f);assertThat(f.exchanges.get()).isEqualTo(1);
    }
}
