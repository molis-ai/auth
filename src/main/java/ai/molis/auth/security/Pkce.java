package ai.molis.auth.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

public final class Pkce {
    private Pkce() {}

    public static boolean validChallenge(String challenge) {
        return challenge != null && challenge.matches("[A-Za-z0-9_-]{43}");
    }

    public static boolean matches(String challenge, String verifier) {
        if (!validChallenge(challenge) || verifier == null || !verifier.matches("[A-Za-z0-9._~-]{43,128}")) return false;
        return MessageDigest.isEqual(challenge.getBytes(StandardCharsets.US_ASCII),
                challenge(verifier).getBytes(StandardCharsets.US_ASCII));
    }

    public static String challenge(String verifier) {
        if (verifier == null || !verifier.matches("[A-Za-z0-9._~-]{43,128}")) {
            throw new IllegalArgumentException("Invalid PKCE verifier");
        }
        try {
            return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256")
                    .digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required", impossible);
        }
    }
}
