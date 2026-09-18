package ai.molis.auth.account;

import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.platform.PlatformAdministrators;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DevelopmentAdminTests {
    private final AccountMapper accounts = mock(AccountMapper.class);
    private final PasswordHashing passwords = new PasswordHashing();
    private DevelopmentAdmin fixture() {
        return new DevelopmentAdmin(accounts, passwords, new PlatformAdministrators(DevelopmentAdmin.USER_ID),
                "http://localhost:8080", "127.0.0.1");
    }
    @Test void createsOnlyTheWhitelistedLocalFixture() {
        var fixture = fixture(); fixture.run(null);
        var hash = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(accounts).insertLocalCredential(eq(DevelopmentAdmin.USER_ID), hash.capture());
        assertThat(passwords.matches("woyidingfacai", hash.getValue())).isTrue();
        assertThat(fixture.resolve("admin")).isEqualTo("admin");
        assertThat(fixture.resolve("someone@example.test")).isEqualTo("someone@example.test");
        assertThatThrownBy(() -> passwords.encodeNew("admin")).hasMessage("INVALID_PASSWORD");
    }
    @Test void restartNeverResetsOrReenablesExistingUser() {
        when(accounts.findByVerifiedEmail(DevelopmentAdmin.EMAIL)).thenReturn(
                new AccountMapper.UserRow(DevelopmentAdmin.USER_ID, "Renamed", "DISABLED"));
        fixture().run(null);
        verify(accounts).findByVerifiedEmail(DevelopmentAdmin.EMAIL);
        verifyNoMoreInteractions(accounts);
    }
    @Test void migratesLegacyFixtureAndRevokesOldSessions() {
        when(accounts.findByVerifiedEmail("admin@local.example.test")).thenReturn(new AccountMapper.UserRow(DevelopmentAdmin.USER_ID, "Renamed", "ACTIVE"));
        fixture().run(null);
        verify(accounts).renameDevelopmentEmail(DevelopmentAdmin.USER_ID, "admin@local.example.test", "admin@example.com");
        var hash = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(accounts).resetDevelopmentPassword(eq(DevelopmentAdmin.USER_ID), hash.capture());
        assertThat(passwords.matches("woyidingfacai", hash.getValue())).isTrue();
        assertThat(passwords.matches("admin", hash.getValue())).isFalse();
        verify(accounts).revokeDevelopmentSessions(DevelopmentAdmin.USER_ID);
        verify(accounts, never()).insertUser(anyString(), anyString());
    }
    @Test void identityCollisionNeverOverwritesData() {
        when(accounts.countUser(DevelopmentAdmin.USER_ID)).thenReturn(1);
        assertThatThrownBy(() -> fixture().run(null)).isInstanceOf(IllegalStateException.class);
        verify(accounts, never()).insertUser(anyString(), anyString());
    }
    @Test void requiresLocalBindingAndWhitelist() {
        assertThatThrownBy(() -> new DevelopmentAdmin(accounts, passwords, new PlatformAdministrators(""),
                "http://localhost:8080", "127.0.0.1")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new DevelopmentAdmin(accounts, passwords,
                new PlatformAdministrators(DevelopmentAdmin.USER_ID), "https://auth.example.com", "0.0.0.0"))
                .isInstanceOf(IllegalStateException.class);
    }
}
