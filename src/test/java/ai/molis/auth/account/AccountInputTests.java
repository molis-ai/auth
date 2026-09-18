package ai.molis.auth.account;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class AccountInputTests {
    private static final PasswordHashing PASSWORDS = new PasswordHashing();

    @Test void canonicalEmailKeepsProviderAliasesSeparate() {
        assertThat(EmailAddress.canonicalize(" Alice.Test+work@GMAIL.COM ")).isEqualTo("alice.test+work@gmail.com");
        assertThat(EmailAddress.canonicalize("alice.test@gmail.com")).isNotEqualTo("alicetest@gmail.com");
    }

    @Test void malformedAndUnsupportedMailboxesAreRejected() {
        for (String email : new String[]{"a..b@example.com", "a@-example.com", "a@example..com", "a\r\nb@example.com",
                "a@localhost", "a".repeat(65) + "@example.com", "用户@example.com", "a@" + "b".repeat(64) + ".com"})
            assertThatIllegalArgumentException().isThrownBy(() -> EmailAddress.canonicalize(email));
    }

    @Test void passwordHashIsVersionedSaltedAndDoesNotTruncate() {
        String raw = "a long passphrase with spaces and punctuation!";
        String first = PASSWORDS.encodeNew(raw), second = PASSWORDS.encodeNew(raw);
        assertThat(first).startsWith("{pbkdf2-sha256-600k-v1}").isNotEqualTo(second).doesNotContain(raw);
        assertThat(PASSWORDS.matches(raw, first)).isTrue();
        assertThat(PASSWORDS.matches(raw + "x", first)).isFalse();
        String longPassword = "xy".repeat(50);
        assertThat(PASSWORDS.matches(longPassword + "y", PASSWORDS.encodeNew(longPassword))).isFalse();
    }

    @Test void unicodeIsNormalizedWithoutTrimmingAndBoundsCountCodePoints() {
        String raw = " é".repeat(15);
        String hash = PASSWORDS.encodeNew(raw);
        assertThat(PASSWORDS.matches(" e\u0301".repeat(15), hash)).isTrue();
        assertThat(PASSWORDS.matches(raw.strip(), hash)).isFalse();
        assertThat(PASSWORDS.matches("😀🙂".repeat(4), PASSWORDS.encodeNew("😀🙂".repeat(4)))).isTrue();
        assertThat(PASSWORDS.matches("R7!mZ2q8", PASSWORDS.encodeNew("R7!mZ2q8"))).isTrue();
        assertThatIllegalArgumentException().isThrownBy(() -> PASSWORDS.encodeNew("😀".repeat(7)));
        assertThatIllegalArgumentException().isThrownBy(() -> PASSWORDS.encodeNew("admin"));
        assertThatIllegalArgumentException().isThrownBy(() -> PASSWORDS.encodeNew("x".repeat(129)));
        assertThatIllegalArgumentException().isThrownBy(() -> PASSWORDS.encodeNew("x".repeat(15) + '\uD800'));
    }

    @Test void unknownAndMalformedHashesNeverFallBackToPlaintext() {
        for (String hash : new String[]{null, "{noop}a very long password", "a very long password", "{unknown}hash"})
            assertThat(PASSWORDS.matches("a very long password", hash)).isFalse();
        assertThat(new AccountOperationMapper.CredentialRow("user", "ACTIVE", "secret-hash").toString())
                .doesNotContain("secret-hash");
    }

    @Test void commonShortPasswordsAreStillBlocked() {
        for (String value : new String[]{"password", "12345678", "Password123", "aaaaaaaa"})
            assertThatThrownBy(() -> PASSWORDS.encodeNew(value)).hasMessage("PASSWORD_BLOCKED");
    }
}
