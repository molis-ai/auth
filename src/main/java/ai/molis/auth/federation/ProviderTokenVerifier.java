package ai.molis.auth.federation;

import ai.molis.auth.account.EmailAddress;
import ai.molis.auth.security.TokenSecrets;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.*;
import com.nimbusds.jose.jwk.source.*;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jose.util.Resource;
import com.nimbusds.jwt.SignedJWT;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Server-side ID-token verification after a state-bound authorization-code exchange.
 * Not an HTTP endpoint: state, callback binding, single-use transaction and rate limits must precede this.
 * Uses Nimbus for RSA signatures; claims are checked without permissive JSON type coercions.
 */
public final class ProviderTokenVerifier implements AutoCloseable {
    private static final JsonMapper JSON=JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final IdentityProvider provider;
    private final String clientId;
    private final Clock clock;
    private final JWKSource<SecurityContext> keys;
    private final ProviderHttp http;
    /** Trusted server/test SPI; never construct this from request parameters or untrusted JWKs. */
    public ProviderTokenVerifier(IdentityProvider provider,String clientId,Clock clock,JWKSource<SecurityContext> keys) {
        this(provider,clientId,clock,keys,null);
    }
    private ProviderTokenVerifier(IdentityProvider provider,String clientId,Clock clock,JWKSource<SecurityContext> keys,ProviderHttp http) {
        this.provider=Objects.requireNonNull(provider);this.clock=Objects.requireNonNull(clock);this.keys=Objects.requireNonNull(keys);this.http=http;
        if(clientId==null||!clientId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,254}")) throw new IllegalArgumentException("Invalid provider registration");
        this.clientId=clientId;
    }
    /** Fixed official JWKS locations. No network request until first verification. */
    public static ProviderTokenVerifier production(IdentityProvider provider,String clientId,Clock clock) {
        var http=new ProviderHttp();
        try {
            var source=JWKSourceBuilder.<SecurityContext>create(provider.keys().toURL(), url -> {
                if(!url.toExternalForm().equals(provider.keys().toString())) throw new java.io.IOException("Provider location rejected");
                try { return new Resource(new String(http.get(provider.keys()),StandardCharsets.UTF_8),"application/json"); }
                catch(ExternalFailure failure) { throw new java.io.IOException("Provider unavailable"); }
            }).cache(300000,5000).refreshAheadCache(false).rateLimited(30000).retrying(false).outageTolerant(false).build();
            return new ProviderTokenVerifier(provider,clientId,clock,source,http);
        } catch(Exception invalid) { http.close();throw new IllegalArgumentException("Invalid provider registration"); }
    }
    public VerifiedIdentity verify(String compact,String expectedNonce,Instant startedAt) {
        return verify(compact,expectedNonce,startedAt,null);
    }
    boolean matches(IdentityProvider provider,String clientId){return this.provider==provider&&this.clientId.equals(clientId);}
    public VerifiedIdentity verify(String compact,String expectedNonce,Instant startedAt,String accessToken) {
        Instant now=clock.instant();
        if(expectedNonce==null||!expectedNonce.matches("[A-Za-z0-9_-]{43}")||startedAt==null||startedAt.isAfter(now.plusSeconds(60))||!now.isBefore(startedAt.plusSeconds(600))) throw ExternalFailure.invalid();
        if(compact==null||compact.length()>16384||!compact.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")) throw ExternalFailure.invalid();
        try {
            var parts=compact.split("\\.");var header=object(parts[0]);var claims=object(parts[1]);
            if(!"RS256".equals(string(header,"alg"))||header.has("crit")||header.has("jku")||header.has("jwk")||header.has("x5u")
                    ||(header.has("typ")&&!"JWT".equals(string(header,"typ")))) throw ExternalFailure.invalid();
            String kid=string(header,"kid");if(kid==null||!kid.matches("[!-~]{1,200}")) throw ExternalFailure.invalid();
            var selector=new JWKSelector(new JWKMatcher.Builder().keyID(kid).keyType(KeyType.RSA).build());
            var selected=keys.get(selector,null).stream().filter(key -> (key.getKeyUse()==null||KeyUse.SIGNATURE.equals(key.getKeyUse()))
                    &&(key.getAlgorithm()==null||JWSAlgorithm.RS256.equals(key.getAlgorithm()))
                    &&(key.getKeyOperations()==null||key.getKeyOperations().contains(KeyOperation.VERIFY))).toList();
            if(selected.size()!=1||!(selected.getFirst() instanceof RSAKey key)||key.size()<2048||key.isPrivate()
                    ||!SignedJWT.parse(compact).verify(new RSASSAVerifier(key))) throw ExternalFailure.invalid();
            if(!provider.accepts(string(claims,"iss"))) throw ExternalFailure.invalid();
            String subject=string(claims,"sub");if(subject==null||!subject.matches("[!-~]{1,255}")) throw ExternalFailure.invalid();
            var aud=claims.get("aud");List<String> audiences=new ArrayList<>();
            if(aud!=null&&aud.isString()) audiences.add(aud.asString());
            else if(aud!=null&&aud.isArray()&&aud.size()<=10) for(var item:aud) { if(!item.isString()) throw ExternalFailure.invalid();audiences.add(item.asString()); }
            if(!audiences.contains(clientId)||new HashSet<>(audiences).size()!=audiences.size()) throw ExternalFailure.invalid();
            if((audiences.size()>1||claims.has("azp"))&&!clientId.equals(string(claims,"azp"))) throw ExternalFailure.invalid();
            String nonce=string(claims,"nonce");if(nonce==null||!MessageDigest.isEqual(expectedNonce.getBytes(StandardCharsets.US_ASCII),nonce.getBytes(StandardCharsets.UTF_8))) throw ExternalFailure.invalid();
            if(claims.has("at_hash")) {
                String hash=string(claims,"at_hash");
                if(accessToken==null||!accessToken.matches("[!-~]{1,8192}")||hash==null||!hash.matches("[A-Za-z0-9_-]{22}"))throw ExternalFailure.invalid();
                String expected=Base64.getUrlEncoder().withoutPadding().encodeToString(Arrays.copyOf(MessageDigest.getInstance("SHA-256").digest(accessToken.getBytes(StandardCharsets.US_ASCII)),16));
                if(!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),hash.getBytes(StandardCharsets.US_ASCII)))throw ExternalFailure.invalid();
            }
            Instant issued=date(claims,"iat"),expires=date(claims,"exp");
            if(!now.isBefore(expires)||!issued.isBefore(expires)||issued.isAfter(now.plusSeconds(60))||issued.isBefore(startedAt.minusSeconds(60))
                    ||(claims.has("nbf")&&date(claims,"nbf").isAfter(now.plusSeconds(60)))) throw ExternalFailure.invalid();
            String email=string(claims,"email");
            if(email!=null) { try { email=EmailAddress.canonicalize(email); } catch(IllegalArgumentException invalid) { email=null; } }
            boolean verified=verified(claims.get("email_verified"));
            String hd=string(claims,"hd");
            boolean authoritative=email!=null&&verified&&(provider==IdentityProvider.APPLE||email.endsWith("@gmail.com")||(hd!=null&&hd.matches("[A-Za-z0-9][A-Za-z0-9.-]{0,252}")));
            String name=provider==IdentityProvider.GOOGLE?string(claims,"name"):null;
            if(name==null||name.isBlank()||name.codePointCount(0,name.length())>120||name.codePoints().anyMatch(Character::isISOControl)) name=provider==IdentityProvider.APPLE?"Apple user":"Google user";
            Instant until=expires.isBefore(now.plusSeconds(300))?expires:now.plusSeconds(300);
            return new VerifiedIdentity(provider,subject,email,authoritative,name.strip(),until,
                    TokenSecrets.digest(provider.name()+"\n"+clientId+"\n"+expectedNonce));
        } catch(ExternalFailure failure) { throw failure; }
        catch(KeySourceException unavailable) { throw ExternalFailure.unavailable(); }
        catch(Exception invalid) { throw ExternalFailure.invalid(); }
    }
    private boolean verified(JsonNode value) {
        if(value==null) return false;
        if(value.isBoolean()) return value.asBoolean();
        if(provider==IdentityProvider.APPLE&&value.isString()&&Set.of("true","false").contains(value.asString())) return "true".equals(value.asString());
        throw ExternalFailure.invalid();
    }
    private static JsonNode object(String encoded) {
        var result=JSON.readTree(Base64.getUrlDecoder().decode(encoded));if(!result.isObject()) throw ExternalFailure.invalid();return result;
    }
    private static String string(JsonNode node,String key) { var value=node.get(key);if(value==null)return null;if(!value.isString())throw ExternalFailure.invalid();return value.asString(); }
    private static Instant date(JsonNode node,String key) { var value=node.get(key);if(value==null||!value.isIntegralNumber()||!value.canConvertToLong())throw ExternalFailure.invalid();return Instant.ofEpochSecond(value.asLong()); }
    @Override public void close() { if(http!=null)http.close();try { if(keys instanceof AutoCloseable closeable)closeable.close(); } catch(Exception ignored) { /* No secrets or runtime background worker. */ } }

    /** Private construction prevents unverified controller DTOs from impersonating a verified identity. */
    public static final class VerifiedIdentity {
        private final IdentityProvider provider;private final String subject,email,name,verificationId;private final boolean authoritativeEmail;private final Instant expiresAt;
        private VerifiedIdentity(IdentityProvider provider,String subject,String email,boolean authoritativeEmail,String name,Instant expiresAt,String verificationId) {
            this.provider=provider;this.subject=subject;this.email=email;this.authoritativeEmail=authoritativeEmail;this.name=name;this.expiresAt=expiresAt;this.verificationId=verificationId;
        }
        public IdentityProvider provider(){return provider;} public String issuer(){return provider.issuer();} public String subject(){return subject;}
        public String email(){return email;} public boolean authoritativeEmail(){return authoritativeEmail;} public String displayName(){return name;}
        public Instant expiresAt(){return expiresAt;} public String verificationId(){return verificationId;}
        // Only authenticated server ciphertext can restore this capability. Never deserialize a request DTO.
        String sealState(ProviderStateCipher cipher,String context) {
            return cipher.seal(JSON.writeValueAsString(new Saved(provider,subject,email,authoritativeEmail,name,expiresAt.toString(),verificationId)),context);
        }
        static VerifiedIdentity openState(ProviderStateCipher cipher,String envelope,String context,Instant now) {
            try {
                var saved=JSON.readValue(cipher.open(envelope,context),Saved.class);
                var expires=Instant.parse(saved.expires());
                if(saved.provider()==null||saved.subject()==null||!saved.subject().matches("[!-~]{1,255}")
                        ||saved.verification()==null||!saved.verification().matches("[0-9a-f]{64}")
                        ||saved.name()==null||saved.name().isBlank()||saved.name().codePointCount(0,saved.name().length())>120
                        ||!now.isBefore(expires)||expires.isAfter(now.plusSeconds(300)))throw ExternalFailure.invalid();
                return new VerifiedIdentity(saved.provider(),saved.subject(),saved.email(),saved.authoritative(),saved.name(),expires,saved.verification());
            } catch(RuntimeException invalid){throw new ExternalFailure("PROVIDER_TRANSACTION_INVALID");}
        }
        private record Saved(IdentityProvider provider,String subject,String email,boolean authoritative,String name,String expires,String verification) {}
        @Override public String toString(){return "VerifiedIdentity["+provider+", REDACTED]";}
    }
}
