package ai.molis.auth.federation;

import ai.molis.auth.security.TokenSecrets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;

class ProviderContinuationStateRedisIT {
    static LettuceConnectionFactory a,b;
    StringRedisTemplate redis;ProviderContinuations one,two;String state,tx,browser,owner;
    @BeforeAll static void connect(){a=connection();b=connection();}
    @AfterAll static void close(){if(a!=null)a.destroy();if(b!=null)b.destroy();}
    static LettuceConnectionFactory connection(){int port=Integer.parseInt(System.getProperty("auth.it.redis-port","0"));if(port<1024||port>65535||port==6379)throw new IllegalArgumentException("Dedicated Redis required");
        var factory=new LettuceConnectionFactory(new RedisStandaloneConfiguration("127.0.0.1",port),LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(2)).shutdownTimeout(Duration.ofMillis(100)).build());factory.afterPropertiesSet();factory.start();return factory;}
    @BeforeEach void setup(){redis=new StringRedisTemplate(a);one=new ProviderContinuations(redis,ProviderStateTests.cipher(),Clock.systemUTC());two=new ProviderContinuations(new StringRedisTemplate(b),ProviderStateTests.cipher(),Clock.systemUTC());state=TokenSecrets.generate();tx=TokenSecrets.generate();browser=TokenSecrets.generate();owner=UUID.randomUUID().toString();}
    @AfterEach void clean(){redis.delete(one.key(state));}
    ProviderTokenVerifier.VerifiedIdentity issue(){var proof=ProviderTestTokens.verified(IdentityProvider.GOOGLE,UUID.randomUUID().toString(),null,TokenSecrets.generate(),Clock.systemUTC());one.create(state,browser,tx,owner,proof);return proof;}
    @Test void protectedCapabilityWorksAcrossNodesWithoutRawIdentityOrSecrets(){var proof=issue();
        var stored=redis.opsForHash().entries(one.key(state));assertThat(stored.toString()).doesNotContain(proof.subject(),proof.verificationId(),browser,tx,owner,state);
        long ttl=redis.getExpire(one.key(state),TimeUnit.MILLISECONDS);
        assertThatThrownBy(()->two.read(state,TokenSecrets.generate(),tx)).hasMessage("PROVIDER_TRANSACTION_INVALID");
        assertThatThrownBy(()->two.read(state,browser,TokenSecrets.generate())).hasMessage("PROVIDER_TRANSACTION_INVALID");
        assertThat(two.read(state,browser,tx).identity().subject()).isEqualTo(proof.subject());
        assertThat(redis.getExpire(one.key(state),TimeUnit.MILLISECONDS)).isPositive().isLessThanOrEqualTo(ttl);
        assertThat(two.consume(state,browser,tx).owner()).isEqualTo(owner);
        assertThatThrownBy(()->one.consume(state,browser,tx)).hasMessage("PROVIDER_TRANSACTION_INVALID");
    }
    @Test void encryptedDeadlineCannotBeExtendedByChangingRedisTtl(){issue();
        var later=new ProviderContinuations(redis,ProviderStateTests.cipher(),Clock.offset(Clock.systemUTC(),Duration.ofSeconds(301)));
        assertThatThrownBy(()->later.read(state,browser,tx)).hasMessage("PROVIDER_TRANSACTION_INVALID");
        redis.persist(one.key(state));assertThatThrownBy(()->two.read(state,browser,tx)).hasMessage("PROVIDER_TRANSACTION_INVALID");
    }
    @Test void tamperingOrCiphertextTransplantCannotRestoreVerifiedIdentity(){issue();String other=TokenSecrets.generate();
        var proof=ProviderTestTokens.verified(IdentityProvider.GOOGLE,UUID.randomUUID().toString(),null,TokenSecrets.generate(),Clock.systemUTC());
        try {one.create(other,browser,tx,owner,proof);redis.opsForHash().put(one.key(state),"payload",redis.opsForHash().get(one.key(other),"payload"));
            assertThatThrownBy(()->two.read(state,browser,tx)).hasMessage("PROVIDER_TRANSACTION_INVALID");
        }finally{redis.delete(one.key(other));}
    }
    @Test void competingNodesConsumeOnce()throws Exception{issue();var gate=new CountDownLatch(1);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var x=executor.submit(()->consume(one,gate));var y=executor.submit(()->consume(two,gate));gate.countDown();
            assertThat(List.of(x.get(5,TimeUnit.SECONDS),y.get(5,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
    }
    @Test void mailboxToLinkPhaseKeepsTheOriginalIdentityDeadlineAndEncryptedEmail(){
        var proof=issue();long before=redis.getExpire(one.key(state),TimeUnit.MILLISECONDS);
        var pending=one.consume(state,browser,tx);String email=UUID.randomUUID()+"@example.test";
        one.create(state,browser,tx,pending.owner(),pending.identity(),email);
        var linked=two.read(state,browser,tx);assertThat(linked.targetEmail()).isEqualTo(email);
        assertThat(linked.identity().expiresAt()).isEqualTo(proof.expiresAt());
        assertThat(redis.getExpire(one.key(state),TimeUnit.MILLISECONDS)).isPositive().isLessThanOrEqualTo(before);
        assertThat(redis.opsForHash().entries(one.key(state)).toString()).doesNotContain(email);
    }
    boolean consume(ProviderContinuations store,CountDownLatch gate)throws Exception{gate.await();try{store.consume(state,browser,tx);return true;}catch(ExternalFailure expected){assertThat(expected).hasMessage("PROVIDER_TRANSACTION_INVALID");return false;}}
}
