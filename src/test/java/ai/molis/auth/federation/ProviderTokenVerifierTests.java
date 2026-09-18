package ai.molis.auth.federation;

import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static ai.molis.auth.federation.ProviderTestTokens.*;

class ProviderTokenVerifierTests {
    static final Instant NOW=Instant.parse("2026-09-15T00:00:00Z");static final Clock CLOCK=Clock.fixed(NOW,ZoneOffset.UTC);
    private Map<String,Object> google(){return claims(IdentityProvider.GOOGLE,"CaseSensitive.Subject","Person@gmail.com",NONCE,NOW);}
    private void invalid(Map<String,Object> claims){try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)){assertThatThrownBy(()->v.verify(sign(claims),NONCE,NOW)).isInstanceOf(ExternalFailure.class).hasMessage("PROVIDER_IDENTITY_INVALID");}}

    @Test void signedGoogleIdentityUsesSubjectAndCanonicalIssuerNotEmail() {
        var c=google();c.put("iss","accounts.google.com");c.put("name","A verified name");
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {
            var result=v.verify(sign(c),NONCE,NOW);
            assertThat(result.issuer()).isEqualTo(IdentityProvider.GOOGLE.issuer());assertThat(result.subject()).isEqualTo("CaseSensitive.Subject");
            assertThat(result.email()).isEqualTo("person@gmail.com");assertThat(result.authoritativeEmail()).isTrue();
            assertThat(result.expiresAt()).isEqualTo(NOW.plusSeconds(300));
            assertThat(result.toString()).doesNotContain(result.subject(),result.email(),NONCE,sign(c));
        }
    }
    @Test void appleVerifiedBooleanOrStringAllowsPrivateRelayWithoutTrustingUnsignedNames() {
        for(Object verified:List.of(true,"true")) {
            var c=claims(IdentityProvider.APPLE,"apple-subject","relay@privaterelay.appleid.com",NONCE,NOW);c.put("email_verified",verified);c.put("name","Untrusted browser name");
            try(var v=verifier(IdentityProvider.APPLE,CLOCK)) {
                var identity=v.verify(sign(c),NONCE,NOW);assertThat(identity.authoritativeEmail()).isTrue();assertThat(identity.displayName()).isEqualTo("Apple user");
            }
        }
    }
    @Test void signedNonGoogleMailboxDoesNotBecomeCurrentMailboxProof() {
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {
            var c=google();c.put("email","someone@third-party.example");assertThat(v.verify(sign(c),NONCE,NOW).authoritativeEmail()).isFalse();
            c.put("hd","workspace.example");assertThat(v.verify(sign(c),NONCE,NOW).authoritativeEmail()).isTrue();
            c.put("email_verified",false);assertThat(v.verify(sign(c),NONCE,NOW).authoritativeEmail()).isFalse();
            c.remove("email");assertThat(v.verify(sign(c),NONCE,NOW).email()).isNull();
            c.put("email_verified","true");invalid(c);
        }
    }
    @Test void issuerAudienceAndAuthorizedPresenterAreExact() {
        for(var change:List.of(Map.entry("iss",(Object)"https://evil.example"),Map.entry("aud",(Object)"another-client"),Map.entry("azp",(Object)"another-client"),
                Map.entry("aud",(Object)List.of(CLIENT,"another-client")),Map.entry("aud",(Object)List.of(CLIENT,CLIENT)))) {
            var c=google();c.put(change.getKey(),change.getValue());invalid(c);
        }
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {var c=google();c.put("aud",List.of(CLIENT,"another-client"));c.put("azp",CLIENT);assertThat(v.verify(sign(c),NONCE,NOW).subject()).isNotBlank();}
    }
    @Test void nonceExpiryIssueTimeAndTransactionWindowCannotBeOmittedOrCoerced() {
        for(String removed:List.of("nonce","iat","exp","sub","aud","iss")){var c=google();c.remove(removed);invalid(c);}
        for(var change:List.of(Map.entry("nonce",(Object)"attacker"),Map.entry("exp",(Object)NOW.getEpochSecond()),Map.entry("iat",(Object)NOW.plusSeconds(61).getEpochSecond()),
                Map.entry("iat",(Object)NOW.minusSeconds(61).getEpochSecond()),Map.entry("nbf",(Object)NOW.plusSeconds(61).getEpochSecond()),
                Map.entry("exp",(Object)"9999999999"),Map.entry("iat",(Object)1.5),Map.entry("sub",(Object)"subject "))) {
            var c=google();c.put(change.getKey(),change.getValue());invalid(c);
        }
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {
            assertThatThrownBy(()->v.verify(sign(google()),NONCE,NOW.minusSeconds(600))).isInstanceOf(ExternalFailure.class);
            assertThatThrownBy(()->v.verify(sign(google()),"short",NOW)).isInstanceOf(ExternalFailure.class);
        }
    }
    @Test void rejectsUnsignedWrongSignatureUnknownKeyWeakKeyAndPrivateKeySources() throws Exception {
        var c=google();String signed=sign(c);
        try(var v=verifier(IdentityProvider.GOOGLE,CLOCK)) {
            String[] parts=signed.split("\\.");parts[1]=Base64.getUrlEncoder().withoutPadding().encodeToString(JSON.writeValueAsBytes(Map.of("sub","attacker")));
            assertThatThrownBy(()->v.verify(String.join(".",parts),NONCE,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
        }
        var generator=java.security.KeyPairGenerator.getInstance("RSA");generator.initialize(1024);
        var weak=new com.nimbusds.jose.jwk.RSAKey.Builder((java.security.interfaces.RSAPublicKey)generator.generateKeyPair().getPublic()).keyID("test-key").build();
        for(var key:List.of(KEY,weak,new RSAKeyGenerator(2048).keyID("test-key").generate().toPublicJWK(),new RSAKeyGenerator(2048).keyID("unknown-key").generate().toPublicJWK()))
            try(var v=new ProviderTokenVerifier(IdentityProvider.GOOGLE,CLIENT,CLOCK,new ImmutableJWKSet<>(new JWKSet(key)))) {
                assertThatThrownBy(()->v.verify(signed,NONCE,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
            }
    }
    @Test void duplicateClaimsTrailingJsonAndUntrustedKeyHeadersAreRejectedBeforeKeyLookup() {
        var calls=new java.util.concurrent.atomic.AtomicInteger();
        try(var v=new ProviderTokenVerifier(IdentityProvider.GOOGLE,CLIENT,CLOCK,(selector,context)->{calls.incrementAndGet();return List.of(KEY.toPublicJWK());})) {
            String claims=JSON.writeValueAsString(google());
            for(String header:List.of("{\"alg\":\"none\",\"kid\":\"test-key\"}","{\"alg\":\"RS256\",\"alg\":\"RS256\",\"kid\":\"test-key\"}",
                    "{\"alg\":\"RS256\",\"kid\":\"test-key\",\"jku\":\"https://evil.example/keys\"}","{\"alg\":\"RS256\",\"kid\":\"test-key\",\"crit\":[]}",
                    "{\"alg\":\"RS256\",\"kid\":\"test-key\",\"typ\":\"at+jwt\"}"))
                assertThatThrownBy(()->v.verify(raw(header,claims),NONCE,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
            for(String body:List.of(claims.substring(0,claims.length()-1)+",\"sub\":\"attacker\"}",claims+" {}"))
                assertThatThrownBy(()->v.verify(raw("{\"alg\":\"RS256\",\"kid\":\"test-key\"}",body),NONCE,NOW)).hasMessage("PROVIDER_IDENTITY_INVALID");
            assertThat(calls).hasValue(0);
        }
    }
    @Test void keyRetrievalOutageIsNotInvalidIdentityAndLeaksNoTransportDetail() {
        try(var v=new ProviderTokenVerifier(IdentityProvider.GOOGLE,CLIENT,CLOCK,(selector,context)->{throw new KeySourceException("private transport detail");})) {
            assertThatThrownBy(()->v.verify(sign(google()),NONCE,NOW)).isInstanceOf(ExternalFailure.class).hasMessage("PROVIDER_UNAVAILABLE").hasNoCause();
        }
    }
    @Test void verificationReceiptIsBoundToProviderRegistrationAndNonce() {
        var a=verified(IdentityProvider.GOOGLE,"s","p@gmail.com",NONCE,CLOCK);var b=verified(IdentityProvider.APPLE,"s","p@gmail.com",NONCE,CLOCK);
        assertThat(a.verificationId()).isNotEqualTo(b.verificationId());
        assertThat(a.verificationId()).isNotEqualTo(verified(IdentityProvider.GOOGLE,"s","p@gmail.com","b".repeat(43),CLOCK).verificationId());
        assertThat(a.verificationId()).isEqualTo(verified(IdentityProvider.GOOGLE,"s","changed@gmail.com",NONCE,CLOCK).verificationId());
    }
}
