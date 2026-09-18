package ai.molis.auth.security;

import java.util.HashSet;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class TokenSecretsTests {
    @Test
    void generatesUrlSafe256BitSecrets() {
        var tokens = new HashSet<String>();
        for (int i = 0; i < 1000; i++) {
            String token = TokenSecrets.generate();
            assertThat(token).matches("[A-Za-z0-9_-]{43}");
            assertThat(tokens.add(token)).isTrue();
        }
    }

    @Test
    void digestUsesKnownSha256AndDoesNotAcceptBlank() {
        assertThat(TokenSecrets.digest("abc"))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThatIllegalArgumentException().isThrownBy(() -> TokenSecrets.digest(null));
        assertThatIllegalArgumentException().isThrownBy(() -> TokenSecrets.digest(" "));
    }
}
