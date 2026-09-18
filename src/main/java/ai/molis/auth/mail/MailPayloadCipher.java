package ai.molis.auth.mail;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** AEAD for transient verification mail payloads, never for Access/Refresh tokens or passwords. */
public final class MailPayloadCipher {
    private final String activeKey;
    private final Map<String, SecretKey> keys;
    private final SecureRandom random = new SecureRandom();
    public MailPayloadCipher(String activeKey, Map<String, String> base64Keys) {
        var parsed = new HashMap<String, SecretKey>();
        try {
            if (base64Keys == null || base64Keys.isEmpty()) throw new IllegalArgumentException();
            base64Keys.forEach((id, encoded) -> {
                if (!id.matches("[A-Za-z0-9_-]{1,40}")) throw new IllegalArgumentException();
                byte[] bytes = Base64.getDecoder().decode(encoded);
                if (bytes.length != 32) throw new IllegalArgumentException();
                parsed.put(id, new SecretKeySpec(bytes, "AES"));
                java.util.Arrays.fill(bytes, (byte) 0);
            });
            if (activeKey == null || !parsed.containsKey(activeKey)) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) { throw new IllegalArgumentException("Invalid mail encryption key configuration"); }
        this.activeKey = activeKey; this.keys = Map.copyOf(parsed);
    }
    public String seal(String plaintext, String context) {
        if (plaintext == null || plaintext.length() > 4096) throw new IllegalArgumentException("Invalid mail payload");
        byte[] nonce = new byte[12]; random.nextBytes(nonce);
        try {
            var cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keys.get(activeKey), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return "v1." + activeKey + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(nonce)
                    + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(encrypted);
        } catch (GeneralSecurityException failure) { throw new IllegalStateException("Mail encryption unavailable"); }
    }
    public String open(String envelope, String context) {
        try {
            if (envelope == null || envelope.length() > 8192) throw new IllegalArgumentException();
            String[] parts = envelope.split("\\.", -1);
            if (parts.length != 4 || !parts[0].equals("v1") || !keys.containsKey(parts[1])) throw new IllegalArgumentException();
            byte[] nonce = Base64.getUrlDecoder().decode(parts[2]);
            if (nonce.length != 12) throw new IllegalArgumentException();
            var cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keys.get(parts[1]), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(Base64.getUrlDecoder().decode(parts[3])), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException failure) {
            throw new IllegalArgumentException("Invalid protected mail payload");
        }
    }
}
