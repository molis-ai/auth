package ai.molis.auth.federation;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.account.*;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.security.TokenSecrets;
import ai.molis.auth.verification.RedisMailboxProofs;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Signed offline provider proof + real Redis mailbox proof + real MySQL. No public continuation is implied. */
@SpringBootTest(classes=AuthApplication.class,properties="auth.ephemeral.enabled=true")
class ExternalMailboxRedisIT {
    @Autowired RedisMailboxProofs proofs;
    @Autowired ExternalMailboxAccounts workflow;
    @Autowired ExternalAccountService service;
    @Autowired ExternalAccountMapper external;
    @Autowired AccountMapper accounts;
    @Autowired LocalAccountService local;
    @Autowired JdbcTemplate jdbc;
    @Autowired Clock clock;
    @MockitoSpyBean AccountEventMapper events;
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p) {
        ExternalAccountIT.db(p);
        p.add("spring.data.redis.host",()->"127.0.0.1");
        p.add("spring.data.redis.port",()->{int port=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));if(port<1024||port>65535||port==6379)throw new IllegalArgumentException("Dedicated Redis required");return port;});
        p.add("spring.data.redis.username",()->"");p.add("spring.data.redis.password",()->"");p.add("spring.data.redis.ssl.enabled",()->false);
    }
    static String id(){return UUID.randomUUID().toString();}
    ProviderTokenVerifier.VerifiedIdentity identity(Clock time) {
        return ProviderTestTokens.verified(IdentityProvider.GOOGLE,id(),null,TokenSecrets.generate(),time);
    }
    RedisMailboxProofs.Issued issue(String email,RedisMailboxProofs.Purpose purpose,String tx) {
        var issued=proofs.issue(email,purpose,tx);proofs.verifyLink(issued.challenge(),issued.deliverySecret());return issued;
    }
    ExternalAccountService.Result register(ProviderTokenVerifier.VerifiedIdentity identity,String challenge,String tx,String request) {
        return workflow.register(identity,challenge,tx,"en",request,result->{});
    }
    int count(String sql,Object...args){return jdbc.queryForObject(sql,Integer.class,args);}

    @Test void verifiedMailboxCreatesPasswordlessAccountWithProviderAndPersonalSpace() {
        var identity=identity(clock);String email=id()+"@example.test",tx=TokenSecrets.generate();
        var proof=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        var result=register(identity,proof.challenge(),tx,id());String user=external.identity(identity.issuer(),identity.subject()).userId();
        assertThat(result.status()).isEqualTo(ExternalAccountService.Status.AUTHENTICATED);assertThat(result.registered()).isTrue();
        assertThat(accounts.findByVerifiedEmail(email).id()).isEqualTo(user);
        assertThat(count("SELECT COUNT(*) FROM auth_space WHERE personal_user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_membership WHERE user_id=? AND role='OWNER'",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_local_credential WHERE user_id=?",user)).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_external_mailbox_receipt WHERE verification_hash=?",identity.verificationId())).isEqualTo(1);
        assertThatThrownBy(()->register(identity,proof.challenge(),tx,id())).isInstanceOf(RuntimeException.class);
    }
    @Test void wrongPurposeUnverifiedAndWrongTransactionDoNotCreateAccountsOrConsumeValidProof() {
        String tx=TokenSecrets.generate(),email=id()+"@example.test";var identity=identity(clock);
        var pending=proofs.issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        assertThatThrownBy(()->register(identity,pending.challenge(),tx,id())).isInstanceOf(RuntimeException.class);
        proofs.verifyLink(pending.challenge(),pending.deliverySecret());
        assertThatThrownBy(()->proofs.consume(pending.challenge(),RedisMailboxProofs.Purpose.REGISTER,tx)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->proofs.consume(pending.challenge(),RedisMailboxProofs.Purpose.PASSWORD_RESET,tx)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->register(identity,pending.challenge(),TokenSecrets.generate(),id())).isInstanceOf(RuntimeException.class);
        for(var purpose:List.of(RedisMailboxProofs.Purpose.REGISTER,RedisMailboxProofs.Purpose.PASSWORD_RESET)) {
            var wrong=issue(email,purpose,tx);
            assertThatThrownBy(()->register(identity,wrong.challenge(),tx,id())).isInstanceOf(RuntimeException.class);
        }
        assertThat(accounts.findByVerifiedEmail(email)).isNull();
        assertThat(register(identity,pending.challenge(),tx,id()).registered()).isTrue();
    }
    @Test void mailboxOfExistingAccountCannotAuthenticateOrLinkThatAccount() {
        String email=id()+"@example.test",tx=TokenSecrets.generate();
        String user=local.registerAfterMailboxVerification(id(),email,"Existing","An existing account testing password","en",id());
        var identity=identity(clock);var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        var result=register(identity,issued.challenge(),tx,id());
        assertThat(result.status()).isEqualTo(ExternalAccountService.Status.ACCOUNT_LINK_REQUIRED);assertThat(result.authenticationId()).isNull();
        assertThat(accounts.findByVerifiedEmail(email).id()).isEqualTo(user);assertThat(external.identity(identity.issuer(),identity.subject())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_external_mailbox_receipt WHERE verification_hash=?",identity.verificationId())).isEqualTo(1);
    }
    @Test void durableMailboxReceiptCannotBeReusedWithAnotherVerifiedProviderIdentity() {
        String tx=TokenSecrets.generate(),email=id()+"@example.test";var identity=identity(clock);
        var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        var mailbox=proofs.consume(issued.challenge(),RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        service.registerWithMailboxAndPublish(identity,mailbox,"en",id(),result->{});
        var another=identity(clock);
        assertThatThrownBy(()->service.registerWithMailboxAndPublish(another,mailbox,"en",id(),result->{})).hasMessage("PROVIDER_IDENTITY_INVALID");
        assertThat(external.identity(another.issuer(),another.subject())).isNull();
    }
    @Test void expiredProviderProofCannotBeResurrectedByFreshMailboxProof() {
        var identity=identity(Clock.offset(clock,Duration.ofMinutes(-6)));String email=id()+"@example.test",tx=TokenSecrets.generate();
        var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        assertThatThrownBy(()->register(identity,issued.challenge(),tx,id())).hasMessage("PROVIDER_IDENTITY_INVALID");
        assertThat(accounts.findByVerifiedEmail(email)).isNull();
        assertThatThrownBy(()->proofs.consume(issued.challenge(),RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx)).isInstanceOf(RuntimeException.class);
    }
    @Test void auditFailureRollsBackAggregateAndReceiptWithoutRestoringRedisProof() {
        var identity=identity(clock);String email=id()+"@example.test",tx=TokenSecrets.generate(),request=id();
        var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        doThrow(new DataAccessResourceFailureException("fixture")).when(events).audit(anyString(),eq("account.external.login"),eq("SUCCESS"),anyString(),anyString(),eq(request),any());
        assertThatThrownBy(()->register(identity,issued.challenge(),tx,request)).isInstanceOf(DataAccessResourceFailureException.class);
        assertThat(accounts.findByVerifiedEmail(email)).isNull();assertThat(external.identity(identity.issuer(),identity.subject())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_external_mailbox_receipt WHERE verification_hash=?",identity.verificationId())).isZero();
        assertThat(count("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=?",email)).isZero();
        assertThatThrownBy(()->register(identity,issued.challenge(),tx,id())).isInstanceOf(RuntimeException.class);
    }
    @Test void publicationFailureRollsBackAllDatabaseEffects() {
        var identity=identity(clock);String email=id()+"@example.test",tx=TokenSecrets.generate();
        var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
        assertThatThrownBy(()->workflow.register(identity,issued.challenge(),tx,"en",id(),result->{throw new IllegalStateException("fixture");})).isInstanceOf(IllegalStateException.class);
        assertThat(accounts.findByVerifiedEmail(email)).isNull();assertThat(external.receipt(identity.verificationId())).isNull();
        assertThat(count("SELECT COUNT(*) FROM auth_external_mailbox_receipt WHERE verification_hash=?",identity.verificationId())).isZero();
    }
    @Test void concurrentDifferentProofsForSameMailboxCreateOnlyOneAggregate() throws Exception {
        String email=id()+"@example.test",tx=TokenSecrets.generate();var latch=new CountDownLatch(1);var registered=new AtomicInteger();
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()) {
            var tasks=new ArrayList<Future<?>>();
            for(int i=0;i<2;i++) {var identity=identity(clock);var issued=issue(email,RedisMailboxProofs.Purpose.EXTERNAL_IDENTITY,tx);
                tasks.add(executor.submit(()->{latch.await();try{if(register(identity,issued.challenge(),tx,id()).registered())registered.incrementAndGet();}catch(ExternalFailure expected){assertThat(expected).hasMessage("PROVIDER_IDENTITY_INVALID");}return null;}));}
            latch.countDown();for(var task:tasks)task.get(15,TimeUnit.SECONDS);
        }
        assertThat(registered.get()).isEqualTo(1);String user=accounts.findByVerifiedEmail(email).id();
        assertThat(count("SELECT COUNT(*) FROM auth_external_identity WHERE user_id=?",user)).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM auth_authentication_session WHERE user_id=?",user)).isEqualTo(1);
    }
}
