package ai.molis.auth.security;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class PkceTests {
    @Test
    void matchesRfc7636S256Example() {
        String verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        String challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assertThat(Pkce.challenge(verifier)).isEqualTo(challenge);
        assertThat(Pkce.matches(challenge, verifier)).isTrue();
    }

    @Test
    void rejectsPlainAndMalformedOrWrongVerifiers() {
        String verifier = "a".repeat(43);
        assertThat(Pkce.matches(verifier, verifier)).isFalse();
        assertThat(Pkce.matches(Pkce.challenge(verifier), "b".repeat(43))).isFalse();
        for (String invalid : new String[] {null, "", "x".repeat(42), "x".repeat(129), "+".repeat(43)}) {
            assertThat(Pkce.matches(Pkce.challenge(verifier), invalid)).isFalse();
            assertThatIllegalArgumentException().isThrownBy(() -> Pkce.challenge(invalid));
        }
    }

    @Test
    void acceptsVerifierBoundaryLengthsAndRejectsInvalidChallenge() {
        for (int length : new int[] {43, 128}) {
            String verifier = "x".repeat(length);
            assertThat(Pkce.matches(Pkce.challenge(verifier), verifier)).isTrue();
        }
        assertThat(Pkce.validChallenge(null)).isFalse();
        assertThat(Pkce.validChallenge("x".repeat(44))).isFalse();
    }
}
