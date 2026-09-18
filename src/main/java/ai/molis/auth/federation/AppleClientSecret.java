package ai.molis.auth.federation;

import com.nimbusds.jose.*;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jwt.*;
import java.security.interfaces.ECPrivateKey;
import java.time.Clock;
import java.util.Date;
import java.util.Objects;
import java.util.function.Supplier;

/** Apple service authentication only; this ES256 JWT is NOT a user ID token or Auth Access Token. */
public final class AppleClientSecret implements ProviderClientSecret {
    private final Supplier<SigningKey> source;
    private final Clock clock;
    public AppleClientSecret(Supplier<SigningKey> source,Clock clock){this.source=Objects.requireNonNull(source);this.clock=Objects.requireNonNull(clock);}
    @Override public String current(String clientId) {
        try {
            ProviderRegistration.clientId(clientId);
            var key=Objects.requireNonNull(source.get());var now=clock.instant();
            var token=new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.keyId()).build(),
                    new JWTClaimsSet.Builder().issuer(key.teamId()).subject(clientId).audience("https://appleid.apple.com")
                            .issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(300))).build());
            token.sign(new ECDSASigner(key.privateKey()));return token.serialize();
        } catch(Exception failure){throw new ExternalFailure("PROVIDER_CONFIGURATION_ERROR");}
    }
    public record SigningKey(String teamId,String keyId,ECPrivateKey privateKey) {
        public SigningKey {
            if(teamId==null||!teamId.matches("[A-Z0-9]{10}")||keyId==null||!keyId.matches("[A-Z0-9]{10}")||privateKey==null
                    ||!Curve.P_256.equals(Curve.forECParameterSpec(privateKey.getParams()))) throw new IllegalArgumentException("Invalid Apple signing configuration");
        }
        @Override public String toString(){return "AppleSigningKey[REDACTED]";}
    }
}
