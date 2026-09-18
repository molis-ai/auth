package ai.molis.auth.account;

import java.text.Normalizer;
import java.util.Map;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/** Expensive hashing is done before taking database locks. No raw passwords in records/logs. */
@Component
public class PasswordHashing {
    private static final String VERSION = "pbkdf2-sha256-600k-v1";
    private final PasswordEncoder encoder;
    private final String dummyHash;
    private final PasswordBlocklist blocklist;

    public PasswordHashing() { this(new PasswordBlocklist("")); }

    @org.springframework.beans.factory.annotation.Autowired
    public PasswordHashing(PasswordBlocklist blocklist) {
        this.blocklist = blocklist;
        var pbkdf2 = new Pbkdf2PasswordEncoder("", 16, 600_000,
                Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256);
        encoder = new DelegatingPasswordEncoder(VERSION, Map.of(VERSION, pbkdf2));
        dummyHash = encoder.encode(ai.molis.auth.security.TokenSecrets.generate());
    }

    public String encodeNew(String raw) {
        return encoder.encode(validateNew(raw));
    }

    /** Cheap validation can run before consuming a one-use mailbox proof. */
    public String validateNew(String raw) {
        String value = normalize(raw);
        if (value == null || value.codePointCount(0, value.length()) < 8)
            throw new PasswordRejectedException("INVALID_PASSWORD");
        if (blocklist.contains(value)) throw new PasswordRejectedException("PASSWORD_BLOCKED");
        return value;
    }

    // Only the explicitly enabled local development bootstrap can use this exception.
    String encodeDevelopmentAdmin() { return encoder.encode("woyidingfacai"); }

    public static final class PasswordRejectedException extends IllegalArgumentException {
        private PasswordRejectedException(String code) { super(code); }
    }

    public boolean matches(String raw, String encoded) {
        String value = normalize(raw);
        boolean wellFormed = value != null;
        if (!wellFormed) value = "invalid-password-input";
        // Unknown users, external-only accounts and malformed stored hashes still pay one KDF cost.
        boolean usableHash = encoded != null && encoded.matches("\\{" + VERSION + "}[0-9a-f]{96}");
        boolean matched = encoder.matches(value, usableHash ? encoded : dummyHash);
        return wellFormed && usableHash && matched;
    }

    private static String normalize(String raw) {
        if (raw == null || raw.length() > 512) return null;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= raw.length() || !Character.isLowSurrogate(raw.charAt(i))) return null;
            } else if (Character.isLowSurrogate(c)) return null;
        }
        String normalized = Normalizer.normalize(raw, Normalizer.Form.NFC);
        return normalized.codePointCount(0, normalized.length()) <= 128 ? normalized : null;
    }
}
