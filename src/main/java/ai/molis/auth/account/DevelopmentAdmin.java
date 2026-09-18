package ai.molis.auth.account;

import ai.molis.auth.authorization.SpaceRole;
import ai.molis.auth.persistence.AccountMapper;
import ai.molis.auth.platform.PlatformAdministrators;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** Explicit local Docker fixture, never enabled by the production defaults. */
@Component
@ConditionalOnProperty(name = "auth.development.admin-enabled", havingValue = "true")
public class DevelopmentAdmin implements ApplicationRunner {
    public static final String USER_ID = "826b9c2a-f24a-4ca6-a747-411a5579b643";
    public static final String EMAIL = "admin@example.com";
    private final AccountMapper accounts;
    private final PasswordHashing passwords;

    public DevelopmentAdmin(AccountMapper accounts, PasswordHashing passwords, PlatformAdministrators admins,
            @Value("${auth.issuer}") String issuer, @Value("${server.address}") String address) {
        if (!"http://localhost:8080".equals(issuer) || !"127.0.0.1".equals(address)
                || !admins.contains(USER_ID))
            throw new IllegalStateException("Development admin requires the local-only issuer, binding and explicit whitelist");
        this.accounts = accounts;
        this.passwords = passwords;
    }

    public String resolve(String identifier) { return identifier; }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        var existing = accounts.findByVerifiedEmail(EMAIL);
        if (existing != null && USER_ID.equals(existing.id())) return;
        var legacy = accounts.findByVerifiedEmail("admin@local.example.test");
        if (existing == null && legacy != null && USER_ID.equals(legacy.id())) {
            accounts.renameDevelopmentEmail(USER_ID, "admin@local.example.test", EMAIL);
            accounts.resetDevelopmentPassword(USER_ID, passwords.encodeDevelopmentAdmin());
            accounts.revokeDevelopmentSessions(USER_ID);
            return;
        }
        if (existing != null || accounts.countUser(USER_ID) != 0)
            throw new IllegalStateException("Development admin identity collision; existing data was not modified");
        accounts.insertUser(USER_ID, "开发管理员");
        accounts.insertVerifiedEmail(UUID.randomUUID().toString(), USER_ID, EMAIL);
        accounts.insertLocalCredential(USER_ID, passwords.encodeDevelopmentAdmin());
        String space = UUID.randomUUID().toString();
        accounts.insertPersonalSpace(space, USER_ID, "个人空间");
        accounts.insertMembership(space, USER_ID, SpaceRole.OWNER);
    }
}
