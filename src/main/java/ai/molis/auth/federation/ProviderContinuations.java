package ai.molis.auth.federation;

import ai.molis.auth.security.TokenSecrets;
import java.time.*;
import java.util.List;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import tools.jackson.databind.json.JsonMapper;

/** Server-only encrypted capabilities; no provider tokens, unverified identity DTOs or browser credentials. */
final class ProviderContinuations {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private static final DefaultRedisScript<List> SCRIPT=new DefaultRedisScript<>();
    static {SCRIPT.setLocation(new ClassPathResource("redis/provider-continuation.lua"));SCRIPT.setResultType(List.class);}
    private final StringRedisTemplate redis;private final ProviderStateCipher cipher;private final Clock clock;
    ProviderContinuations(StringRedisTemplate redis,ProviderStateCipher cipher,Clock clock){this.redis=redis;this.cipher=cipher;this.clock=clock;}
    void create(String state,String browser,String transaction,String owner,ProviderTokenVerifier.VerifiedIdentity identity) {
        create(state,browser,transaction,owner,identity,identity.authoritativeEmail()?identity.email():null);
    }
    void create(String state,String browser,String transaction,String owner,ProviderTokenVerifier.VerifiedIdentity identity,String targetEmail) {
        String binding=binding(browser,transaction),context=key(state)+"\n"+binding;
        long ttl=Duration.between(clock.instant(),identity.expiresAt()).toMillis();
        if(ttl<1||ttl>300000)throw invalid();
        String payload=cipher.seal(JSON.writeValueAsString(new Saved(owner,identity.sealState(cipher,context+"\nidentity"),targetEmail)),context);
        execute(state,"create",binding,payload,Long.toString(ttl));
    }
    Pending read(String state,String browser,String transaction){return load(state,browser,transaction,"read");}
    Pending consume(String state,String browser,String transaction){return load(state,browser,transaction,"consume");}
    private Pending load(String state,String browser,String transaction,String operation) {
        String binding=binding(browser,transaction),context=key(state)+"\n"+binding;
        var data=execute(state,operation,binding);
        try {
            var saved=JSON.readValue(cipher.open((String)data.getFirst(),context),Saved.class);
            if(saved.owner()==null||!saved.owner().matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw invalid();
            var identity=ProviderTokenVerifier.VerifiedIdentity.openState(cipher,saved.identity(),context+"\nidentity",clock.instant());
            String email=saved.targetEmail();
            if(email==null&&identity.authoritativeEmail())email=identity.email();
            if(email!=null&&!ai.molis.auth.account.EmailAddress.canonicalize(email).equals(email))throw invalid();
            return new Pending(saved.owner(),identity,email);
        } catch(RuntimeException invalid){throw invalid();}
    }
    String key(String state){opaque(state);return "auth:v1:provider-continuation:"+TokenSecrets.digest(state);}
    private static String binding(String browser,String tx){opaque(browser);opaque(tx);return TokenSecrets.digest(browser+"\n"+tx);}
    private static void opaque(String value){if(value==null||!value.matches("[A-Za-z0-9_-]{43}"))throw invalid();}
    private List<?> execute(String state,String...args){try{var result=redis.execute(SCRIPT,List.of(key(state)),(Object[])args);if(result==null||result.isEmpty())throw invalid();return result;}catch(DataAccessException unavailable){throw new ExternalFailure("AUTH_UNAVAILABLE");}}
    private static ExternalFailure invalid(){return new ExternalFailure("PROVIDER_TRANSACTION_INVALID");}
    private record Saved(String owner,String identity,String targetEmail) {}
    record Pending(String owner,ProviderTokenVerifier.VerifiedIdentity identity,String targetEmail){@Override public String toString(){return "Continuation[REDACTED]";}}
}
