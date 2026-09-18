package ai.molis.auth.federation;

import com.nimbusds.jose.jwk.*;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import tools.jackson.databind.json.JsonMapper;

/** Only test code holds a signing key. Production accepts no fixture issuer/registration/key override. */
public final class ProviderTestTokens {
    public static final String CLIENT="test-provider-client",NONCE="n".repeat(43);
    public static final RSAKey KEY=key();
    public static final JsonMapper JSON=JsonMapper.builder().build();
    private static RSAKey key(){try{return new RSAKeyGenerator(2048).keyID("test-key").generate();}catch(Exception e){throw new AssertionError(e);}}
    public static ProviderTokenVerifier verifier(IdentityProvider provider,Clock clock) {
        return new ProviderTokenVerifier(provider,CLIENT,clock,new ImmutableJWKSet<>(new JWKSet(KEY.toPublicJWK())));
    }
    public static Map<String,Object> claims(IdentityProvider provider,String subject,String email,String nonce,Instant now) {
        var claims=new LinkedHashMap<String,Object>();claims.put("iss",provider.issuer());claims.put("sub",subject);claims.put("aud",CLIENT);
        claims.put("iat",now.getEpochSecond());claims.put("exp",now.plusSeconds(3600).getEpochSecond());claims.put("nonce",nonce);
        if(email!=null){claims.put("email",email);claims.put("email_verified",true);}return claims;
    }
    public static String sign(Map<String,Object> claims){return raw("{\"alg\":\"RS256\",\"kid\":\"test-key\"}",JSON.writeValueAsString(claims));}
    public static String raw(String header,String claims) {
        try {
            var encoder=Base64.getUrlEncoder().withoutPadding();String input=encoder.encodeToString(header.getBytes(StandardCharsets.UTF_8))+"."+encoder.encodeToString(claims.getBytes(StandardCharsets.UTF_8));
            var signer=Signature.getInstance("SHA256withRSA");signer.initSign(KEY.toPrivateKey());signer.update(input.getBytes(StandardCharsets.US_ASCII));
            return input+"."+encoder.encodeToString(signer.sign());
        }catch(Exception e){throw new AssertionError(e);}
    }
    public static ProviderTokenVerifier.VerifiedIdentity verified(IdentityProvider provider,String subject,String email,String nonce,Clock clock) {
        try(var verifier=verifier(provider,clock)){return verifier.verify(sign(claims(provider,subject,email,nonce,clock.instant())),nonce,clock.instant());}
    }
}
