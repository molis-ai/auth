package ai.molis.auth.federation;

import java.net.URI;

/** Deployment chooses registrations, never issuer/JWKS URLs supplied by a browser or token. */
public enum IdentityProvider {
    GOOGLE("https://accounts.google.com", "https://www.googleapis.com/oauth2/v3/certs", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token"),
    APPLE("https://appleid.apple.com", "https://appleid.apple.com/auth/keys", "https://appleid.apple.com/auth/authorize", "https://appleid.apple.com/auth/token");
    private final String issuer;
    private final URI keys;
    private final URI authorization,token;
    IdentityProvider(String issuer,String keys,String authorization,String token) { this.issuer=issuer;this.keys=URI.create(keys);this.authorization=URI.create(authorization);this.token=URI.create(token); }
    public String issuer() { return issuer; }
    public URI keys() { return keys; }
    public URI authorization() { return authorization; }
    public URI token() { return token; }
    boolean accepts(String value) { return issuer.equals(value)||(this==GOOGLE&&"accounts.google.com".equals(value)); }
}
