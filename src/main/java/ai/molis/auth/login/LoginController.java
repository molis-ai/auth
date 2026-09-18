package ai.molis.auth.login;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/auth/transactions")
@ConditionalOnProperty(name = "auth.login.enabled", havingValue = "true")
public final class LoginController {
    private final LoginCoordinator login;
    private final Clock clock;
    public LoginController(LoginCoordinator login, Clock clock) { this.login = login; this.clock = clock; }
    @PostMapping public Envelope begin(@Valid @RequestBody Begin body, HttpServletRequest request) {
        return reply(login.begin(body, request.getHeader("Origin"), request.getRemoteAddr()), request);
    }
    @GetMapping("/context") public Envelope context(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token, HttpServletRequest request) {
        return reply(login.context(token, request.getHeader("Origin")), request);
    }
    @PostMapping("/signup") public Envelope signup(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token,@Valid @RequestBody Signup body,HttpServletRequest request){
        return reply(Map.of("continueUrl",login.signup(token,body,request.getHeader("Origin"),request.getRemoteAddr(),requestId(request))),request);
    }
    public record Signup(@NotBlank @Size(max=254) String email,@NotNull @Size(max=512) String password,@NotNull @Size(max=512) String confirmPassword){
        @Override public String toString(){return "Signup[REDACTED]";}
    }
    @PostMapping("/password") public Envelope password(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token,
            @Valid @RequestBody Password body, HttpServletRequest request) {
        return reply(Map.of("continueUrl", login.password(token, body.email(), body.password(), request.getHeader("Origin"),
                request.getRemoteAddr(), requestId(request))), request);
    }
    @PostMapping("/restore") public Envelope restore(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token, HttpServletRequest request) {
        String name = cookieName(request);
        String cookie = request.getCookies() == null ? null : Arrays.stream(request.getCookies()).filter(value -> value.getName().equals(name))
                .map(jakarta.servlet.http.Cookie::getValue).findFirst().orElse(null);
        return reply(Map.of("continueUrl", login.restore(token, cookie, request.getHeader("Origin"))), request);
    }
    @PostMapping("/confirmation") public Envelope confirmation(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token,
            @RequestBody Map<String, Object> body, HttpServletRequest request, HttpServletResponse response) {
        if (!body.isEmpty()) throw new LoginFailure(400, "INVALID_REQUEST");
        var preview = login.confirmation(token, request.getHeader("Origin"), CompletionCookies.read(request, token, true), request.getRemoteAddr());
        CompletionCookies.write(request, response, token, preview.browser(), preview.seconds());
        return reply(Map.of("confirmation", preview.proof(), "account", preview.account()), request);
    }
    @PostMapping("/cancel") public Envelope cancel(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token,
            @Valid @RequestBody Confirmation body, HttpServletRequest request, HttpServletResponse response) {
        login.cancelConfirmation(token, request.getHeader("Origin"), CompletionCookies.read(request, token, false), body.confirmation());
        CompletionCookies.write(request, response, token, "", 0);
        return reply(Map.of("cancelled", true), request);
    }
    @PostMapping("/complete") public Envelope complete(@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String token,
            @Valid @RequestBody Confirmation body,
            HttpServletRequest request, HttpServletResponse response) {
        var finished = login.completeConfirmed(token, request.getHeader("Origin"), CompletionCookies.read(request, token, false), body.confirmation(), Boolean.TRUE.equals(body.confirmed()));
        if (finished.cookieSecret() != null) {
            var cookie = ResponseCookie.from(cookieName(request), finished.cookieSecret()).httpOnly(true).secure(request.isSecure())
                    .sameSite("Lax").path("/").maxAge(Duration.between(clock.instant(), finished.cookieExpiresAt())).build();
            response.addHeader("Set-Cookie", cookie.toString());
        }
        CompletionCookies.write(request, response, token, "", 0);
        return reply(Map.of("redirectTo", finished.redirectTo()), request);
    }
    static String cookieName(HttpServletRequest request) { return request.isSecure() ? "__Host-auth_session" : "auth_session_dev"; }
    static String requestId(HttpServletRequest request) { return (String) request.getAttribute(AuthHttpBoundary.REQUEST_ID); }
    private static Envelope reply(Object data, HttpServletRequest request) { return new Envelope(data, requestId(request)); }
    public record Envelope(Object data, String requestId) {}
    public record Begin(@NotBlank @Size(max=100) String clientId, @NotBlank @Size(max=1024) String redirectUri,
                        @NotBlank @Size(max=43) String codeChallenge, @NotBlank String codeChallengeMethod,
                        @NotBlank @Size(max=128) String state, @NotEmpty @Size(max=2) Set<@NotBlank String> scopes, Boolean forceLogin) {
        public Begin { forceLogin = Boolean.TRUE.equals(forceLogin); }
    }
    public record Password(@NotBlank @Size(max=254) String email, @NotNull @Size(max=512) String password) {
        @Override public String toString() { return "Password[REDACTED]"; }
    }
    public record Confirmation(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{43}") String confirmation, Boolean confirmed) {
        @Override public String toString() { return "Confirmation[REDACTED]"; }
    }
}
