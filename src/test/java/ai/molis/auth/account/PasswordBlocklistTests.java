package ai.molis.auth.account;

import ai.molis.auth.security.TokenSecrets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.assertj.core.api.Assertions.*;

class PasswordBlocklistTests {
    @TempDir Path directory;
    @Test void bundledSnapshotBlocksLongCommonPasswordsAndCaseVariants() {
        var policy=new PasswordBlocklist("");
        assertThat(policy.contains("mailcreated5240")).isTrue();
        assertThat(policy.contains("MAILCREATED5240")).isTrue();
        assertThat(policy.contains("123456789987654321")).isTrue();
        assertThatThrownBy(()->new PasswordHashing(policy).validateNew("mailcreated5240"))
                .isInstanceOf(PasswordHashing.PasswordRejectedException.class).hasMessage("PASSWORD_BLOCKED");
    }
    @Test void additionalListUsesWholeNormalizedValuesAndDoesNotRejectExistingPasswords() throws Exception {
        String password="An explicitly blocked phrase é";
        Path list=directory.resolve("additional.sha256");
        Files.writeString(list,TokenSecrets.digest(password.toLowerCase(Locale.ROOT))+"\n");
        var policy=new PasswordBlocklist(list.toString());
        assertThat(policy.contains(password.toUpperCase(Locale.ROOT))).isTrue();
        assertThat(policy.contains("An explicitly blocked phrase e\u0301")).isTrue();
        assertThat(policy.contains("prefix "+password+" suffix")).isFalse();
        var encoder=new PasswordHashing(policy);
        assertThatThrownBy(()->encoder.encodeNew(password)).isInstanceOf(PasswordHashing.PasswordRejectedException.class).hasMessage("PASSWORD_BLOCKED");
        String previous=new PasswordHashing().encodeNew(password);
        assertThat(encoder.matches(password,previous)).isTrue();
        assertThat(encoder.matches(password.toUpperCase(Locale.ROOT),previous)).isFalse();
    }
    @Test void unavailableOrMalformedConfiguredListFailsClosed() throws Exception {
        assertThatThrownBy(()->new PasswordBlocklist(directory.resolve("missing").toString())).isInstanceOf(IllegalStateException.class);
        Path invalid=directory.resolve("bad.sha256");Files.writeString(invalid,"not a digest\n");
        assertThatThrownBy(()->new PasswordBlocklist(invalid.toString())).isInstanceOf(IllegalStateException.class);
    }
}
