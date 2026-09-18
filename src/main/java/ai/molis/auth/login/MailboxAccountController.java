package ai.molis.auth.login;

import ai.molis.auth.verification.RedisMailboxProofs;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/auth")
@ConditionalOnProperty(name = {"auth.login.enabled", "auth.mail.enabled"}, havingValue = "true")
public final class MailboxAccountController {
    private final MailboxAccountCoordinator accounts;
    public MailboxAccountController(MailboxAccountCoordinator accounts) { this.accounts = accounts; }
    @PostMapping("/transactions/mailbox") public LoginController.Envelope request(
            @RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String transaction, @Valid @RequestBody MailRequest body,
            HttpServletRequest request) {
        throw new LoginFailure(409,"EMAIL_FLOW_UNAVAILABLE");
    }
    @PostMapping("/mailbox/verify") public LoginController.Envelope verify(@Valid @RequestBody Verification body, HttpServletRequest request) {
        throw new LoginFailure(409,"EMAIL_FLOW_UNAVAILABLE");
    }
    @PostMapping("/transactions/register") public LoginController.Envelope register(
            @RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String transaction, @Valid @RequestBody Register body,
            HttpServletRequest request) {
        throw new LoginFailure(409,"EMAIL_FLOW_UNAVAILABLE");
    }
    @PostMapping("/transactions/reset-password") public LoginController.Envelope reset(
            @RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String transaction, @Valid @RequestBody Reset body,
            HttpServletRequest request) {
        throw new LoginFailure(409,"EMAIL_FLOW_UNAVAILABLE");
    }
    private static LoginController.Envelope reply(Object data, HttpServletRequest request) {
        return new LoginController.Envelope(data, LoginController.requestId(request));
    }
    public record MailRequest(@NotBlank @Size(max=254) String email, @NotNull RedisMailboxProofs.Purpose purpose,
                              @NotNull @Pattern(regexp="en|zh-CN") String locale) {}
    public record Verification(@NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String challenge,
                               @NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String secret,
                               @NotNull @AssertTrue Boolean confirmed) {
        @Override public String toString() { return "Verification[REDACTED]"; }
    }
    public record Register(@NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String challenge,
                           @NotBlank @Size(max=120) String displayName, @NotNull @Size(max=512) String password,
                           @NotNull @Pattern(regexp="en|zh-CN") String locale) {
        @Override public String toString() { return "Register[REDACTED]"; }
    }
    public record Reset(@NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String challenge,
                        @NotNull @Size(max=512) String password, @NotNull @Pattern(regexp="en|zh-CN") String locale) {
        @Override public String toString() { return "Reset[REDACTED]"; }
    }
}
