package ai.molis.auth.login;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class AuthPageController {
    private final LoginClientPolicy policy;
    private final ObjectProvider<MailboxAccountCoordinator> mailboxes;
    private final ObjectProvider<ai.molis.auth.platform.ConsoleRegistration> console;
    private final ObjectProvider<ai.molis.auth.federation.ProviderConfiguration.ProviderClients> providers;
    public AuthPageController(LoginClientPolicy policy, ObjectProvider<MailboxAccountCoordinator> mailboxes,
            ObjectProvider<ai.molis.auth.platform.ConsoleRegistration> console,
            ObjectProvider<ai.molis.auth.federation.ProviderConfiguration.ProviderClients> providers) {
        this.policy = policy; this.mailboxes = mailboxes; this.console=console; this.providers=providers;
    }
    @GetMapping({"/", "/login", "/provider", "/provider-mailbox", "/register", "/forgot-password", "/complete", "/verify-email", "/console", "/console/callback"})
    public ResponseEntity<Resource> page() {
        Resource page = new ClassPathResource("static/auth-ui/index.html");
        if (!page.exists()) return ResponseEntity.status(503).contentType(MediaType.TEXT_PLAIN)
                .body(new ByteArrayResource("Auth UI is not packaged. Build with the web Maven profile.".getBytes(StandardCharsets.UTF_8)));
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(page);
    }
    @GetMapping("/api/v1/auth/ui-configuration")
    public LoginController.Envelope configuration(jakarta.servlet.http.HttpServletRequest request) {
        return new LoginController.Envelope(Map.of("mailboxEnabled", false,
                "authOrigin", policy.authOrigin(),"providers",providers.getIfAvailable()==null?java.util.List.of():providers.getObject().enabledProviders(),
                "console",console.getIfAvailable()==null?ai.molis.auth.platform.ConsoleRegistration.View.disabled():console.getObject().configuration()), LoginController.requestId(request));
    }
}
