package ai.molis.auth.federation;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Dedicated deployment key ring for short-lived provider transactions, not provider or user tokens. */
public final class ProviderStateCipher {
    private final String activeKey;
    private final Map<String, SecretKey> keys;
    private final SecureRandom random = new SecureRandom();

    public ProviderStateCipher(String activeKey, Map<String, String> base64Keys) {
        var parsed = new HashMap<String, SecretKey>();
        try {
            if (base64Keys == null || base64Keys.isEmpty()) throw new IllegalArgumentException();
            base64Keys.forEach((id, encoded) -> {
                if (id == null || !id.matches("[A-Za-z0-9_-]{1,40}")) throw new IllegalArgumentException();
                byte[] bytes = Base64.getDecoder().decode(encoded);
                try {
                    if (bytes.length != 32) throw new IllegalArgumentException();
                    parsed.put(id, new SecretKeySpec(bytes, "AES"));
                } finally { Arrays.fill(bytes, (byte) 0); }
            });
            if (activeKey == null || !parsed.containsKey(activeKey)) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) {
            throw new IllegalArgumentException("Invalid provider state key configuration");
        }
        this.activeKey = activeKey;
        this.keys = Map.copyOf(parsed);
    }

    String seal(String plaintext, String context) {
        if (plaintext == null || plaintext.getBytes(StandardCharsets.UTF_8).length > 4096)
            throw new IllegalArgumentException("Invalid provider state payload");
        byte[] nonce = new byte[12]; random.nextBytes(nonce);
        try {
            var cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keys.get(activeKey), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(context));
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return "v1." + activeKey + "." + encode(nonce) + "." + encode(encrypted);
        } catch (GeneralSecurityException failure) {
            throw new ExternalFailure("PROVIDER_CONFIGURATION_ERROR");
        }
    }

    String open(String envelope, String context) {
        try {
            if (envelope == null || envelope.length() > 8192) throw new IllegalArgumentException();
            String[] parts = envelope.split("\\.", -1);
            if (parts.length != 4 || !parts[0].equals("v1") || !keys.containsKey(parts[1])) throw new IllegalArgumentException();
            byte[] nonce = Base64.getUrlDecoder().decode(parts[2]);
            if (nonce.length != 12) throw new IllegalArgumentException();
            var cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keys.get(parts[1]), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(context));
            byte[] plaintext = cipher.doFinal(Base64.getUrlDecoder().decode(parts[3]));
            if (plaintext.length > 4096) throw new IllegalArgumentException();
            return new String(plaintext, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException failure) {
            throw new ExternalFailure("PROVIDER_TRANSACTION_INVALID");
        }
    }

    private static byte[] aad(String context) {
        if (context == null || context.isEmpty() || context.length() > 1024) throw new IllegalArgumentException();
        return ("auth:provider-state:v1\n" + context).getBytes(StandardCharsets.UTF_8);
    }
    private static String encode(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
}
