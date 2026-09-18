package ai.molis.auth.account;

import ai.molis.auth.security.TokenSecrets;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/** Full-value offline comparisons only. Never sends password material to a third party. */
@Component
public final class PasswordBlocklist {
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private final Set<String> hashes;
    public PasswordBlocklist(@Value("${auth.password.blocklist-file:}") String extraFile) {
        var entries = new HashSet<String>();
        // Supplement the bundled long-passphrase corpus for the 8-character minimum.
        for (String common : new String[]{"password", "password1", "password123", "password1234", "password!",
                "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890", "12345678910",
                "87654321", "qwertyui", "qwertyuiop", "qwerty123", "qwerty12345", "abcdefgh",
                "abc12345", "abc123456", "iloveyou", "admin123", "admin1234", "admin12345", "adminadmin",
                "letmein1", "welcome1", "welcome123", "changeme", "changeme123", "asdfghjk", "asdfghjkl"})
            entries.add(TokenSecrets.digest(common));
        try (var stream = new ClassPathResource("security/common-password-sha256.txt").getInputStream()) {
            load(entries, stream.readNBytes(MAX_BYTES + 1));
            if (!extraFile.isBlank()) {
                try (var extra = Files.newInputStream(Path.of(extraFile))) { load(entries, extra.readNBytes(MAX_BYTES + 1)); }
            }
        } catch (IOException invalid) { throw new IllegalStateException("Password blocklist unavailable"); }
        if (entries.isEmpty()) throw new IllegalStateException("Empty password blocklist");
        hashes = Set.copyOf(entries);
    }
    public boolean contains(String value) {
        if (value.codePoints().distinct().limit(2).count() == 1) return true;
        return hashes.contains(TokenSecrets.digest(Normalizer.normalize(value, Normalizer.Form.NFC).toLowerCase(Locale.ROOT)));
    }
    private static void load(Set<String> hashes, byte[] data) {
        if (data.length > MAX_BYTES) throw new IllegalStateException("Password blocklist too large");
        for (String line : new String(data, StandardCharsets.UTF_8).split("\\R")) {
            if (line.isBlank() || line.startsWith("#")) continue;
            if (!line.matches("[a-f0-9]{64}")) throw new IllegalStateException("Invalid password blocklist entry");
            hashes.add(line);
        }
    }
}
