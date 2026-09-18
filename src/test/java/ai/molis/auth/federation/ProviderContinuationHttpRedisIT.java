package ai.molis.auth.federation;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.login.*;
import ai.molis.auth.mail.*;
import ai.molis.auth.security.*;
import java.net.URI;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
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

/** Real HTTP security chain, Redis, MySQL and mail outbox. Signed offline provider and in-memory mail transport. */
@SpringBootTest(classes=AuthApplication.class,properties={"auth.login.enabled=true","auth.ephemeral.enabled=true","auth.federation.enabled=true",
        "auth.issuer=https://auth.example.test","auth.mail.enabled=true","auth.mail.origin=https://auth.example.test","auth.mail.worker.enabled=false"})
@AutoConfigureMockMvc
class ProviderContinuationHttpRedisIT {
    static final String AUTH="https://auth.example.test",PRODUCT="https://product.example.test";
    @Autowired MockMvc mvc;@Autowired LoginCoordinator login;@Autowired RedisAuthTransactions auth;
    @Autowired JdbcTemplate jdbc;@Autowired MailDispatcher dispatcher;
    @TestBean(enforceOverride=true) MailTransport mailTransport;
    @TestBean(enforceOverride=true) ProviderConfiguration.ProviderClients providerClients;
    static MailTransport mailTransport(){return new DevelopmentInbox();}
    static ProviderConfiguration.ProviderClients providerClients(){return ProviderHttpRedisIT.providerClients();}
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p){ProviderHttpRedisIT.infrastructure(p);p.add("auth.mail.crypto.keys.primary",()->ProviderStateTests.testKey(1));}
    String address;
    @BeforeEach void address(){address="2001:db8:"+id().replace("-","").substring(0,24).replaceAll("(.{4})(?=.)","$1:");}
    @AfterEach void clear(){ProviderHttpRedisIT.RESPONSES.clear();ProviderHttpRedisIT.CALLS.clear();}
    static String id(){return UUID.randomUUID().toString();}
    MvcResult send(MockHttpServletRequestBuilder request)throws Exception{return mvc.perform(request.secure(true).with(r->{r.setRemoteAddr(address);return r;})).andReturn();}
    String tx(){String application=id(),client="continuation-"+id(),registered=id();
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES (?,'Continuation fixture','ACTIVE')",application);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES (?,?,?,'WEB','ACTIVE','account')",registered,client,application);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES (?,?)",registered,PRODUCT+"/callback");
        return login.begin(new LoginController.Begin(client,PRODUCT+"/callback",Pkce.challenge("v".repeat(43)),"S256",TokenSecrets.generate(),Set.of("account"),false),PRODUCT,address).transaction();}
    record Fixture(String tx,String state,String cookie,String subject,String code){}
    Fixture start()throws Exception {return start(null);}
    Fixture start(String providerEmail)throws Exception {
        String tx=tx();var response=send(post("/api/v1/auth/providers/google/start").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,tx).contentType("application/json").content("{}"));
        assertThat(response.getResponse().getStatus()).isEqualTo(200);
        String cookie=response.getResponse().getHeader("Set-Cookie").split(";",2)[0];
        var url=URI.create(data(response).path("authorizationUrl").asString());var args=ProviderHttpRedisIT.query(url.getRawQuery());
        String state=args.get("state"),code=TokenSecrets.generate(),subject=id();
        ProviderHttpRedisIT.RESPONSES.put(code,ProviderTestTokens.claims(IdentityProvider.GOOGLE,subject,providerEmail,args.get("nonce"),Clock.systemUTC().instant()));
        var callback=send(get("/oauth2/callback/google").header("Cookie",cookie).with(r->{r.setQueryString("state="+state+"&code="+code);return r;}));
        assertThat(callback.getResponse().getStatus()).isEqualTo(303);
        assertThat(callback.getResponse().getHeader("Location")).isEqualTo(AUTH+"/provider-mailbox#transaction="+tx+"&continuation="+state);
        assertThat(callback.getResponse().getHeader("Set-Cookie")).contains("HttpOnly","Secure","SameSite=None","Max-Age=300");
        return new Fixture(tx,state,cookie,subject,code);
    }
    tools.jackson.databind.JsonNode data(MvcResult result)throws Exception{return ProviderTestTokens.JSON.readTree(result.getResponse().getContentAsString()).path("data");}
    MvcResult call(Fixture f,String action,Map<String,Object> fields)throws Exception {var body=new HashMap<>(fields);body.put("continuation",f.state());return send(post("/api/v1/auth/providers/continuation/"+action)
            .header("Origin",AUTH).header("Cookie",f.cookie()).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json").content(ProviderTestTokens.JSON.writeValueAsString(body)));}
    String request(Fixture f,String email)throws Exception {var result=call(f,"mailbox",Map.of("email",email,"locale","en"));assertThat(result.getResponse().getStatus()).isEqualTo(200);return data(result).path("challenge").asString();}
    void verify(String email,String challenge)throws Exception {
        String message=jdbc.queryForObject("SELECT id FROM auth_mail_outbox WHERE recipient_email=? AND template_key='VERIFY_EXTERNAL_IDENTITY'",String.class,email);
        assertThat(MailTestDelivery.dispatch(dispatcher,message)).isTrue();
        String link=((DevelopmentInbox)mailTransport).messages().stream().filter(m->m.id().equals(message)).findFirst().orElseThrow().body().lines().filter(line->line.startsWith(AUTH+"/verify-email#")).findFirst().orElseThrow();
        String secret=URI.create(link).getFragment().split("&token=")[1];
        var response=send(post("/api/v1/auth/mailbox/verify").header("Origin",AUTH).contentType("application/json").content(ProviderTestTokens.JSON.writeValueAsString(Map.of("challenge",challenge,"secret",secret,"confirmed",true))));
        assertThat(response.getResponse().getStatus()).isEqualTo(200);
    }
    Map<String,Object> complete(String challenge){return Map.of("challenge",challenge,"locale","en","confirmed",true);}
    int identities(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM auth_external_identity WHERE subject=?",Integer.class,f.subject());}
    @Autowired ai.molis.auth.account.LocalAccountService local;
    @Autowired ExternalAccountService externalAccounts;
    static final String PASSWORD="An existing account password for linking";
    record Second(IdentityProvider provider,String state,String code,String cookie){}
    Second reauthenticate(Fixture f,IdentityProvider provider,String subject)throws Exception {
        String name=provider.name().toLowerCase(Locale.ROOT);
        var started=call(f,"reauthenticate",Map.of("provider",name,"confirmed",true));assertThat(started.getResponse().getStatus()).isEqualTo(200);
        var args=ProviderHttpRedisIT.query(URI.create(data(started).path("authorizationUrl").asString()).getRawQuery());String code=TokenSecrets.generate();
        // A provider's changed email must not select a different account; only its existing issuer/subject binding can.
        ProviderHttpRedisIT.RESPONSES.put(code,ProviderTestTokens.claims(provider,subject,id()+"@unrelated.test",args.get("nonce"),Clock.systemUTC().instant()));
        return new Second(provider,args.get("state"),code,started.getResponse().getHeader("Set-Cookie").split(";",2)[0]);
    }
    MvcResult secondCallback(Second second)throws Exception {
        String form="state="+second.state()+"&code="+second.code();
        var request=second.provider()==IdentityProvider.GOOGLE?get("/oauth2/callback/google").with(r->{r.setQueryString(form);return r;})
                :post("/oauth2/callback/apple").header("Origin","https://appleid.apple.com").contentType("application/x-www-form-urlencoded").content(form);
        return send(request.header("Cookie",second.cookie()));
    }
    String existingProvider(IdentityProvider provider,String subject,String email) {
        var proof=ProviderTestTokens.verified(provider,subject,email,TokenSecrets.generate(),Clock.systemUTC());externalAccounts.login(proof,"en",id());
        return jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,subject);
    }
    @Test void existingGoogleAndAppleIdentitiesCanReauthenticateWithoutPasswordOrMailboxMatching()throws Exception {
        for(var provider:IdentityProvider.values()) {
            String email=id()+"@gmail.com",subject=id(),user=existingProvider(provider,subject,email);var f=start(email);
            var second=reauthenticate(f,provider,subject);var result=secondCallback(second);
            assertThat(result.getResponse().getHeader("Location")).isEqualTo(AUTH+"/complete#transaction="+f.tx());
            assertThat(result.getResponse().getHeaders("Set-Cookie")).hasSize(2);
            assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,f.subject())).isEqualTo(user);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_local_credential WHERE user_id=?",Integer.class,user)).isZero();
            assertThat(auth.read(f.tx()).status()).isEqualTo("AUTHENTICATED");
            assertThat(secondCallback(second).getResponse().getHeader("Location")).contains("PROVIDER_TRANSACTION_INVALID");
        }
    }
    @Test void secondProviderMustBeAlreadyBoundToTheTargetNotAnotherOrANewAccount()throws Exception {
        for(boolean otherAccount:List.of(false,true)) {
            String email=id()+"@gmail.com",subject=id();existingProvider(IdentityProvider.APPLE,subject,email);var f=start(email);
            String wrong=id();if(otherAccount)existingProvider(IdentityProvider.APPLE,wrong,id()+"@gmail.com");
            var result=secondCallback(reauthenticate(f,IdentityProvider.APPLE,wrong));
            assertThat(result.getResponse().getHeader("Location")).contains("INVALID_CREDENTIALS");assertThat(identities(f)).isZero();
        }
    }
    @Test void cancellingOriginalContinuationWhileAtProviderPreventsAnyLaterLink()throws Exception {
        String email=id()+"@gmail.com",subject=id();existingProvider(IdentityProvider.APPLE,subject,email);var f=start(email);
        var second=reauthenticate(f,IdentityProvider.APPLE,subject);assertThat(call(f,"cancel",Map.of()).getResponse().getStatus()).isEqualTo(200);
        assertThat(secondCallback(second).getResponse().getHeader("Location")).contains("INVALID_TRANSACTION");assertThat(identities(f)).isZero();
        assertThat(ProviderHttpRedisIT.CALLS).doesNotContainKey(second.code());
    }
    @Test void verifiedMailboxConflictCanContinueWithOriginalPasswordWithoutRepeatingProvider()throws Exception {
        String email=id()+"@example.test",user=local.registerAfterMailboxVerification(id(),email,"Existing fixture",PASSWORD,"en",id());
        var f=start();String challenge=request(f,email);verify(email,challenge);
        var transition=call(f,"complete",complete(challenge));assertThat(transition.getResponse().getStatus()).isEqualTo(200);
        assertThat(data(transition).path("linkRequired").asBoolean()).isTrue();assertThat(identities(f)).isZero();
        assertThat(data(call(f,"context",Map.of())).path("email").asString()).isEqualTo(email);
        assertThat(call(f,"complete",complete(challenge)).getResponse().getStatus()).isEqualTo(400);
        assertThat(call(f,"link-password",Map.of("password",PASSWORD,"confirmed",true)).getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,f.subject())).isEqualTo(user);
        assertThat(ProviderHttpRedisIT.CALLS.get(f.code()).get()).isEqualTo(1);
    }
    @Test void verifiedMailboxConflictCanContinueWithAlreadyBoundProvider()throws Exception {
        String email=id()+"@gmail.com",subject=id(),user=existingProvider(IdentityProvider.APPLE,subject,email);var f=start();
        String challenge=request(f,email);verify(email,challenge);
        assertThat(data(call(f,"complete",complete(challenge))).path("linkRequired").asBoolean()).isTrue();
        assertThat(secondCallback(reauthenticate(f,IdentityProvider.APPLE,subject)).getResponse().getHeader("Location")).isEqualTo(AUTH+"/complete#transaction="+f.tx());
        assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,f.subject())).isEqualTo(user);
    }
    @Test void sameEmailPasswordReauthenticationLinksOriginalAccountWithoutNewSpace()throws Exception {
        String email=id()+"@gmail.com",user=local.registerAfterMailboxVerification(id(),email,"Existing fixture",PASSWORD,"en",id());
        var f=start(email);var preview=call(f,"context",Map.of());
        assertThat(data(preview).path("mode").asString()).isEqualTo("LINK_PASSWORD");assertThat(data(preview).path("email").asString()).isEqualTo(email);
        assertThat(call(f,"link-password",Map.of("password","wrong","confirmed",true)).getResponse().getStatus()).isEqualTo(401);
        assertThat(identities(f)).isZero();assertThat(auth.read(f.tx()).status()).isEqualTo("BUSY");
        assertThat(call(f,"link-password",Map.of("password",PASSWORD,"confirmed",false)).getResponse().getStatus()).isEqualTo(400);
        assertThat(call(f,"link-password",Map.of("password",PASSWORD,"confirmed",true,"userId",id())).getResponse().getStatus()).isEqualTo(400);
        var result=call(f,"link-password",Map.of("password",PASSWORD,"confirmed",true));assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT user_id FROM auth_external_identity WHERE subject=?",String.class,f.subject())).isEqualTo(user);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_space WHERE personal_user_id=?",Integer.class,user)).isEqualTo(1);
        assertThat(auth.read(f.tx()).status()).isEqualTo("AUTHENTICATED");
        assertThat(call(f,"link-password",Map.of("password",PASSWORD,"confirmed",true)).getResponse().getStatus()).isEqualTo(400);
    }
    @Test void mailboxContinuationCannotUsePasswordLinkAndLinkCannotChangeMailbox()throws Exception {
        var mailbox=start();assertThat(call(mailbox,"link-password",Map.of("password",PASSWORD,"confirmed",true)).getResponse().getStatus()).isEqualTo(400);
        String email=id()+"@gmail.com";local.registerAfterMailboxVerification(id(),email,"Existing fixture",PASSWORD,"en",id());
        var link=start(email);
        assertThat(call(link,"mailbox",Map.of("email",id()+"@example.test","locale","en")).getResponse().getStatus()).isEqualTo(400);
        assertThat(call(link,"cancel",Map.of()).getResponse().getStatus()).isEqualTo(200);assertThat(identities(link)).isZero();
    }
    @Test void disabledExistingUserCannotLinkEvenWithCorrectPassword()throws Exception {
        String email=id()+"@gmail.com",user=local.registerAfterMailboxVerification(id(),email,"Existing fixture",PASSWORD,"en",id());var f=start(email);
        jdbc.update("UPDATE auth_user SET status='DISABLED' WHERE id=?",user);
        assertThat(call(f,"link-password",Map.of("password",PASSWORD,"confirmed",true)).getResponse().getStatus()).isEqualTo(401);assertThat(identities(f)).isZero();
    }
    @Test void callbackMailVerificationAndExplicitCompletionCreateOneAccountAndRequireLoginConfirmation()throws Exception {
        var f=start();assertThat(auth.read(f.tx()).status()).isEqualTo("BUSY");
        assertThat(call(f,"context",Map.of()).getResponse().getStatus()).isEqualTo(200);
        String email=id()+"@example.test",challenge=request(f,email);
        var early=call(f,"complete",complete(challenge));assertThat(early.getResponse().getStatus()).isEqualTo(400);assertThat(early.getResponse().getContentAsString()).contains("INVALID_PROOF");
        assertThat(identities(f)).isZero();verify(email,challenge);assertThat(identities(f)).isZero();
        var result=call(f,"complete",complete(challenge));assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(data(result).path("continueUrl").asString()).isEqualTo(AUTH+"/complete#transaction="+f.tx());
        assertThat(result.getResponse().getHeader("Set-Cookie")).contains("Max-Age=0");
        assertThat(auth.read(f.tx()).status()).isEqualTo("AUTHENTICATED");assertThat(identities(f)).isEqualTo(1);
        var confirm=send(post("/api/v1/auth/transactions/confirmation").header("Origin",AUTH).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json").content("{}"));
        assertThat(confirm.getResponse().getStatus()).isEqualTo(200);
        assertThat(call(f,"complete",complete(challenge)).getResponse().getStatus()).isEqualTo(400);
        assertThat(ProviderHttpRedisIT.CALLS.get(f.code()).get()).isEqualTo(1);
    }
    @Test void browserTransactionOriginAndStrictBodyCannotBeSubstituted()throws Exception {
        var f=start();
        for(String cookie:List.of("",ProviderHttpBoundary.cookieName(f.state())+"="+TokenSecrets.generate(),f.cookie()+"; "+f.cookie()))
            assertThat(call(new Fixture(f.tx(),f.state(),cookie,f.subject(),f.code()),"context",Map.of()).getResponse().getStatus()).isEqualTo(400);
        assertThat(call(new Fixture(tx(),f.state(),f.cookie(),f.subject(),f.code()),"context",Map.of()).getResponse().getStatus()).isEqualTo(400);
        assertThat(call(f,"context",Map.of("userId",id())).getResponse().getStatus()).isEqualTo(400);
        assertThat(send(post("/api/v1/auth/providers/continuation/context").header("Origin",PRODUCT).header("Cookie",f.cookie()).header(AuthHttpBoundary.TRANSACTION_HEADER,f.tx()).contentType("application/json").content(ProviderTestTokens.JSON.writeValueAsString(Map.of("continuation",f.state())))).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(f,"context",Map.of()).getResponse().getStatus()).isEqualTo(200);assertThat(identities(f)).isZero();
    }
    @Test void cancelConsumesContinuationWithoutCreatingAccount()throws Exception {
        var f=start();String email=id()+"@example.test",challenge=request(f,email);verify(email,challenge);
        assertThat(call(f,"cancel",Map.of()).getResponse().getStatus()).isEqualTo(200);
        assertThat(call(f,"complete",complete(challenge)).getResponse().getStatus()).isEqualTo(400);assertThat(identities(f)).isZero();
        assertThatThrownBy(()->auth.read(f.tx())).hasMessage("INVALID_TRANSACTION");
    }
    @Test void disabledClientAfterMailRequestCannotRegister()throws Exception {
        var f=start();String email=id()+"@example.test",challenge=request(f,email);verify(email,challenge);
        jdbc.update("UPDATE auth_login_client SET status='DISABLED' WHERE client_id=?",auth.read(f.tx()).context().clientId());
        assertThat(call(f,"complete",complete(challenge)).getResponse().getStatus()).isNotEqualTo(200);assertThat(identities(f)).isZero();
    }
    @Test void sameMailboxConflictDoesNotMergeOrAuthenticateExistingUser()throws Exception {
        var f=start();String email=id()+"@example.test",user=id();
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES (?,'Existing fixture','ACTIVE')",user);
        jdbc.update("INSERT INTO auth_user_email(id,user_id,canonical_email,verified_at) VALUES (?,?,?,CURRENT_TIMESTAMP(6))",id(),user,email);
        String challenge=request(f,email);verify(email,challenge);
        var result=call(f,"complete",complete(challenge));assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(data(result).path("linkRequired").asBoolean()).isTrue();assertThat(identities(f)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",Integer.class,user)).isZero();
    }
    @Test void concurrentCompletionHasOnlyOneSuccess()throws Exception {
        var f=start();String email=id()+"@example.test",challenge=request(f,email);verify(email,challenge);var gate=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            Callable<Integer> task=()->{gate.await();return call(f,"complete",complete(challenge)).getResponse().getStatus();};
            var a=executor.submit(task);var b=executor.submit(task);gate.countDown();
            assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,400);
        }
        assertThat(identities(f)).isEqualTo(1);
    }
}
