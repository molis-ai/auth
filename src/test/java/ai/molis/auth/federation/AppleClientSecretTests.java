package ai.molis.auth.federation;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.jwk.*;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jwt.SignedJWT;
import java.time.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class AppleClientSecretTests {
    static final Instant NOW=Instant.parse("2026-09-15T00:00:00Z");static final Clock CLOCK=Clock.fixed(NOW,ZoneOffset.UTC);
    @Test void producesRealEs256ClientAssertionWithFiveMinuteLifetime() throws Exception {
        var key=new ECKeyGenerator(Curve.P_256).generate();var configured=new AppleClientSecret.SigningKey("TEAM123456","KEY1234567",key.toECPrivateKey());
        var source=new AppleClientSecret(()->configured,CLOCK);var jwt=SignedJWT.parse(source.current("com.example.auth"));
        assertThat(jwt.getHeader().getAlgorithm()).isEqualTo(JWSAlgorithm.ES256);assertThat(jwt.getHeader().getKeyID()).isEqualTo("KEY1234567");
        assertThat(jwt.verify(new ECDSAVerifier(key.toPublicJWK()))).isTrue();
        var claims=jwt.getJWTClaimsSet();assertThat(claims.getIssuer()).isEqualTo("TEAM123456");assertThat(claims.getSubject()).isEqualTo("com.example.auth");
        assertThat(claims.getAudience()).containsExactly("https://appleid.apple.com");assertThat(claims.getIssueTime().toInstant()).isEqualTo(NOW);assertThat(claims.getExpirationTime().toInstant()).isEqualTo(NOW.plusSeconds(300));
        assertThat(configured.toString()).doesNotContain("TEAM123456","KEY1234567",key.toJSONString());
    }
    @Test void credentialRotationReadsFreshKeyAndDoesNotKeepOldAssertion() throws Exception {
        var first=new ECKeyGenerator(Curve.P_256).generate();var next=new ECKeyGenerator(Curve.P_256).generate();
        var reference=new AtomicReference<>(new AppleClientSecret.SigningKey("TEAM123456","KEY1234567",first.toECPrivateKey()));var secrets=new AppleClientSecret(reference::get,CLOCK);
        assertThat(SignedJWT.parse(secrets.current("com.example.auth")).verify(new ECDSAVerifier(first.toPublicJWK()))).isTrue();
        reference.set(new AppleClientSecret.SigningKey("TEAM123456","KEY7654321",next.toECPrivateKey()));
        var jwt=SignedJWT.parse(secrets.current("com.example.auth"));assertThat(jwt.getHeader().getKeyID()).isEqualTo("KEY7654321");assertThat(jwt.verify(new ECDSAVerifier(next.toPublicJWK()))).isTrue();assertThat(jwt.verify(new ECDSAVerifier(first.toPublicJWK()))).isFalse();
    }
    @Test void rejectsWrongCurveMalformedIdentifiersAndMissingKeys() throws Exception {
        var wrong=new ECKeyGenerator(Curve.P_384).generate();var valid=new ECKeyGenerator(Curve.P_256).generate();
        assertThatThrownBy(()->new AppleClientSecret.SigningKey("TEAM123456","KEY1234567",wrong.toECPrivateKey())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->new AppleClientSecret.SigningKey("bad","KEY1234567",valid.toECPrivateKey())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->new AppleClientSecret(()->null,CLOCK).current("com.example.auth")).hasMessage("PROVIDER_CONFIGURATION_ERROR").hasNoCause();
        assertThatThrownBy(()->new AppleClientSecret(()->{throw new IllegalStateException("private-key-material");},CLOCK).current("com.example.auth")).hasMessage("PROVIDER_CONFIGURATION_ERROR").hasNoCause();
    }
}
