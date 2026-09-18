package ai.molis.auth.federation;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.*;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.session.SessionService;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real MySQL and signed test-provider tokens. No public OAuth callback or live Google/Apple is exercised. */
@SpringBootTest(classes=AuthApplication.class)
class ExternalAccountIT {
    @Autowired ExternalAccountService service;
    @Autowired LocalAccountService local;
    @Autowired ExternalAccountMapper external;
    @Autowired AccountMapper accounts;
    @Autowired SessionService sessions;
    @Autowired JdbcTemplate jdbc;
    @Autowired Clock clock;
    @MockitoSpyBean AccountEventMapper events;
    @MockitoSpyBean PasswordHashing passwords;
    @DynamicPropertySource static void db(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable test database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));
        p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    private static String id(){return UUID.randomUUID().toString();}
    private ProviderTokenVerifier.VerifiedIdentity proof(IdentityProvider provider,String subject,String email) {
        return ProviderTestTokens.verified(provider,subject,email,TokenSecrets.generate(),clock);
    }
    private String user(ProviderTokenVerifier.VerifiedIdentity proof){return external.identity(proof.issuer(),proof.subject()).userId();}
    private int count(String sql,Object... args){return jdbc.queryForObject(sql,Integer.class,args);}
    @Test void twoProviderLinkAuditFailureRollsBackBothProofReceiptsAndBinding() {
        String email=id()+"@gmail.com",subject=id(),request=id();
        var first=proof(IdentityProvider.APPLE,subject,email);service.login(first,"en",id());String user=user(first);
        var incoming=proof(IdentityProvider.GOOGLE,id(),email);var existing=proof(IdentityProvider.APPLE,subject,null);
        doThrow(new DataAccessResourceFailureException("fixture")).when(events).audit(anyString(),eq("account.external.bind"),eq("SUCCESS"),eq(user),eq(user),eq(request),any());
        assertThatThrownBy(()->service.linkWithProviderAndPublish(incoming,existing,email,request,r->{})).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(external.identity(incoming.issuer(),incoming.subject())).isNull();assertThat(external.receipt(incoming.verificationId())).isNull();assertThat(external.receipt(existing.verificationId())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
    }
    @Test void twoProviderLinkCannotReplayProofOrSurvivePublicationFailure() {
        String email=id()+"@gmail.com",subject=id();var first=proof(IdentityProvider.APPLE,subject,email);service.login(first,"en",id());String user=user(first);
        var incoming=proof(IdentityProvider.GOOGLE,id(),email);var existing=proof(IdentityProvider.APPLE,subject,null);
        assertThatThrownBy(()->service.linkWithProviderAndPublish(incoming,existing,email,id(),r->{throw new IllegalStateException("fixture");})).isInstanceOf(IllegalStateException.class);
        assertThat(external.identity(incoming.issuer(),incoming.subject())).isNull();assertThat(external.receipt(existing.verificationId())).isNull();
        var result=service.linkWithProviderAndPublish(incoming,existing,email,id(),r->{});
        assertThat(external.receipt(existing.verificationId()).authenticationId()).isEqualTo(result.authenticationId());
        var another=proof(IdentityProvider.GOOGLE,id(),email);
        assertThatThrownBy(()->service.linkWithProviderAndPublish(another,existing,email,id(),r->{})).hasMessage("PROVIDER_IDENTITY_INVALID");
        assertThat(external.identity(another.issuer(),another.subject())).isNull();assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(2);
    }

    @Test void passwordLinkAuditFailureRollsBackIdentityRootAndReceipt() {
        String email=id()+"@gmail.com",request=id(),password="An existing account link password";
        String user=local.registerAfterMailboxVerification(id(),email,"Existing",password,"en",id());
        var p=proof(IdentityProvider.GOOGLE,id(),email);
        doThrow(new DataAccessResourceFailureException("fixture")).when(events).audit(anyString(),eq("account.external.bind"),eq("SUCCESS"),eq(user),eq(user),eq(request),any());
        assertThatThrownBy(()->service.linkWithPasswordAndPublish(p,password,request,r->{})).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(external.receipt(p.verificationId())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE request_id=?",request)).isZero();
    }
    @Test void passwordLinkPublicationFailureRollsBackWithoutChangingExistingAccount() {
        String email=id()+"@gmail.com",password="An existing account link password";
        String user=local.registerAfterMailboxVerification(id(),email,"Existing",password,"en",id());var p=proof(IdentityProvider.GOOGLE,id(),email);
        assertThatThrownBy(()->service.linkWithPasswordAndPublish(p,password,id(),r->{throw new IllegalStateException("fixture");})).isInstanceOf(IllegalStateException.class);
        assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(external.receipt(p.verificationId())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isZero();
        assertThat(accounts.findByVerifiedEmail(email).id()).isEqualTo(user);
    }
    @Test void passwordResetDuringKdfInvalidatesTheOldPasswordBeforeLinkCommit() {
        String email=id()+"@gmail.com",password="An existing account link password";
        String user=local.registerAfterMailboxVerification(id(),email,"Existing",password,"en",id());var p=proof(IdentityProvider.GOOGLE,id(),email);
        doAnswer(invocation->{boolean matched=(boolean)invocation.callRealMethod();
            local.resetPasswordAfterMailboxVerification(id(),email,"A newly reset existing account password","en",id());return matched;
        }).when(passwords).matches(eq(password),anyString());
        assertThatThrownBy(()->service.linkWithPasswordAndPublish(p,password,id(),r->{})).hasMessage("INVALID_CREDENTIALS");
        assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isZero();
    }
    @Test void concurrentPasswordLinksCommitOnlyOneIdentityAndAuthentication()throws Exception {
        String email=id()+"@gmail.com",password="An existing account link password";
        String user=local.registerAfterMailboxVerification(id(),email,"Existing",password,"en",id());var p=proof(IdentityProvider.GOOGLE,id(),email);var gate=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            Callable<Boolean> task=()->{gate.await();try{service.linkWithPasswordAndPublish(p,password,id(),r->{});return true;}catch(ExternalFailure expected){assertThat(expected).hasMessage("PROVIDER_IDENTITY_INVALID");return false;}};
            var a=executor.submit(task);var b=executor.submit(task);gate.countDown();assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(external.identity(p.issuer(),p.subject()).userId()).isEqualTo(user);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
    }

    @Test void firstLoginCreatesOnlyOneAggregateAndNoLocalPassword() {
        var proof=proof(IdentityProvider.GOOGLE,id(),id()+"@gmail.com");var result=service.login(proof,"en",id());String user=user(proof);
        assertThat(result.status()).isEqualTo(ExternalAccountService.Status.AUTHENTICATED);assertThat(result.registered()).isTrue();
        assertThat(count("SELECT COUNT(*) FROM auth_user WHERE id=? AND status='ACTIVE'",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_space s JOIN auth_membership m ON m.space_id=s.id WHERE s.personal_user_id=? AND m.user_id=? AND m.role='OWNER'",user,user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_local_credential WHERE user_id=?",user)).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=? AND template_key='ACCOUNT_REGISTERED'",proof.email())).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE id=? AND cookie_hash IS NULL",result.authenticationId())).isEqualTo(1);
        assertThat(service.login(proof,"zh-CN",id())).isEqualTo(result);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id=? AND action='account.external.login'",user)).isEqualTo(1);
        assertThatThrownBy(()->local.resetPasswordAfterMailboxVerification(id(),proof.email(),"A brand new password testing phrase","en",id())).hasMessage("RESET_NOT_AVAILABLE");
    }
    @Test void returningSubjectIgnoresChangedOrMissingEmailAndPreservesExistingOwnership() {
        String subject=id(),email=id()+"@gmail.com";var first=proof(IdentityProvider.GOOGLE,subject,email);service.login(first,"en",id());String user=user(first);
        String anotherEmail=id()+"@example.test";String another=local.registerAfterMailboxVerification(id(),anotherEmail,"Existing mailbox owner","An existing mailbox password phrase","en",id());
        for(String changed:Arrays.asList(anotherEmail,null)) {
            var result=service.login(proof(IdentityProvider.GOOGLE,subject,changed),"en",id());
            assertThat(result.status()).isEqualTo(ExternalAccountService.Status.AUTHENTICATED);assertThat(result.registered()).isFalse();
            assertThat(jdbc.queryForObject("SELECT user_id FROM auth_authentication_session WHERE id=?",String.class,result.authenticationId())).isEqualTo(user);
        }
        assertThat(accounts.findByVerifiedEmail(email).id()).isEqualTo(user);assertThat(accounts.findByVerifiedEmail(anotherEmail).id()).isEqualTo(another);
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE user_id=?",user)).isEqualTo(1);
    }
    @Test void sameMailboxDoesNotLinkOrCreateAnotherUserOrSpace() {
        String email=id()+"@gmail.com";String user=local.registerAfterMailboxVerification(id(),email,"Local account","A local account testing password","en",id());
        for(var provider:IdentityProvider.values()) {
            var p=proof(provider,id(),email);var result=service.login(p,"en",id());
            assertThat(result.status()).isEqualTo(ExternalAccountService.Status.ACCOUNT_LINK_REQUIRED);assertThat(result.authenticationId()).isNull();
            assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(external.receipt(p.verificationId())).isNull();
        }
        assertThat(count("SELECT COUNT(*) FROM auth_user_email WHERE canonical_email=?",email)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_space WHERE personal_user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isZero();
    }
    @Test void nonAuthoritativeOrMissingEmailCannotCreateVerifiedMailbox() {
        for(String email:Arrays.asList(id()+"@third-party.test",null)) {
            var p=proof(IdentityProvider.GOOGLE,id(),email);
            assertThat(service.login(p,"en",id()).status()).isEqualTo(ExternalAccountService.Status.MAILBOX_VERIFICATION_REQUIRED);
            assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(external.receipt(p.verificationId())).isNull();
        }
    }
    @Test void applePrivateRelayFirstLoginDoesNotRequireALocalPassword() {
        var p=proof(IdentityProvider.APPLE,id(),id()+"@privaterelay.appleid.com");
        assertThat(service.login(p,"zh-CN",id()).registered()).isTrue();String user=user(p);
        assertThat(count("SELECT COUNT(*) FROM auth_local_credential WHERE user_id=?",user)).isZero();assertThat(accounts.findByVerifiedEmail(p.email()).id()).isEqualTo(user);
    }
    @Test void disabledUsersAndRevokedReceiptsCannotRecreateSessions() {
        String subject=id();var p=proof(IdentityProvider.GOOGLE,subject,id()+"@gmail.com");service.login(p,"en",id());String user=user(p);
        sessions.revokeAll(user);assertThatThrownBy(()->service.login(p,"en",id())).hasMessage("INVALID_CREDENTIALS");
        sessions.disableUser(user);
        assertThatThrownBy(()->service.login(proof(IdentityProvider.GOOGLE,subject,null),"en",id())).hasMessage("INVALID_CREDENTIALS");
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id=? AND action='account.external.login' AND outcome='DENIED'",user)).isEqualTo(1);
    }
    @Test void auditFailureRollsBackNewAccountPersonalSpaceIdentityAndReceipt() {
        var p=proof(IdentityProvider.GOOGLE,id(),id()+"@gmail.com");String request=id();
        doThrow(new DataAccessResourceFailureException("private audit failure")).when(events).audit(anyString(),eq("account.external.login"),eq("SUCCESS"),anyString(),anyString(),eq(request),any());
        assertThatThrownBy(()->service.login(p,"en",request)).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(accounts.findByVerifiedEmail(p.email())).isNull();assertThat(external.identity(p.issuer(),p.subject())).isNull();assertThat(external.receipt(p.verificationId())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=?",p.email())).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE request_id=?",request)).isZero();
    }
    @Test void concurrentSameProofHasOneAggregateRootReceiptAndLoginAudit() throws Exception {
        var p=proof(IdentityProvider.GOOGLE,id(),id()+"@gmail.com");var latch=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            Callable<ExternalAccountService.Result> task=()->{latch.await();return service.login(p,"en",id());};var a=executor.submit(task);var b=executor.submit(task);latch.countDown();
            assertThat(a.get(15,TimeUnit.SECONDS)).isEqualTo(b.get(15,TimeUnit.SECONDS));
        }
        String user=user(p);assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_audit_event WHERE target_user_id=? AND action='account.external.login'",user)).isEqualTo(1);
    }
    @Test void concurrentDifferentProofsShareIdentityButCreateDistinctAuthenticationRoots() throws Exception {
        String subject=id(),email=id()+"@gmail.com";var p=proof(IdentityProvider.GOOGLE,subject,email);var second=proof(IdentityProvider.GOOGLE,subject,email);var latch=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            var a=executor.submit(()->{latch.await();return service.login(p,"en",id());});var b=executor.submit(()->{latch.await();return service.login(second,"en",id());});latch.countDown();
            assertThat(a.get(15,TimeUnit.SECONDS).authenticationId()).isNotEqualTo(b.get(15,TimeUnit.SECONDS).authenticationId());
        }
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user(p))).isEqualTo(2);
        assertThat(count("SELECT COUNT(*) FROM auth_space WHERE personal_user_id=?",user(p))).isEqualTo(1);
    }
    @Test void byteExactSubjectsDoNotAliasByCaseAndReceiptCannotChangeSubject() {
        String subject="CASE-"+id();var p=proof(IdentityProvider.GOOGLE,subject,id()+"@gmail.com");service.login(p,"en",id());
        var different=proof(IdentityProvider.GOOGLE,subject.toLowerCase(Locale.ROOT),id()+"@gmail.com");service.login(different,"en",id());assertThat(user(different)).isNotEqualTo(user(p));
        String nonce=TokenSecrets.generate();var first=ProviderTestTokens.verified(IdentityProvider.GOOGLE,id(),id()+"@gmail.com",nonce,clock);service.login(first,"en",id());
        var substituted=ProviderTestTokens.verified(IdentityProvider.GOOGLE,id(),id()+"@gmail.com",nonce,clock);
        assertThatThrownBy(()->service.login(substituted,"en",id())).hasMessage("PROVIDER_IDENTITY_INVALID");assertThat(external.identity(substituted.issuer(),substituted.subject())).isNull();
    }
    @Test void expiredVerifiedCapabilityDoesNotBecomeAReusableRegistrationDto() {
        Clock old=Clock.offset(clock,Duration.ofMinutes(-6));var p=ProviderTestTokens.verified(IdentityProvider.GOOGLE,id(),id()+"@gmail.com",TokenSecrets.generate(),old);
        assertThatThrownBy(()->service.login(p,"en",id())).hasMessage("PROVIDER_IDENTITY_INVALID");assertThat(external.identity(p.issuer(),p.subject())).isNull();
    }
}
