package ai.molis.auth.login;

import ai.molis.auth.session.SelfSessionService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Collections;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnProperty(name="auth.login.enabled", havingValue="true")
public final class SelfAccountController {
    private final SelfSessionService sessions;
    public SelfAccountController(SelfSessionService sessions) { this.sessions=sessions; }
    @GetMapping("/api/v1/sessions/login-methods") public LoginController.Envelope loginMethods(HttpServletRequest request){
        return new LoginController.Envelope(sessions.loginMethods(bearer(request),request.getHeader("Origin")),LoginController.requestId(request));
    }
    @PostMapping("/api/v1/sessions/login-methods/{id}/unlink") public LoginController.Envelope unlink(@PathVariable String id,@RequestBody Map<String,Object> body,HttpServletRequest request){
        if(!body.isEmpty())throw new LoginFailure(400,"INVALID_REQUEST");
        return new LoginController.Envelope(sessions.unlink(bearer(request),request.getHeader("Origin"),id,LoginController.requestId(request)),LoginController.requestId(request));
    }
    @GetMapping("/api/v1/sessions/authentications") public LoginController.Envelope authentications(
            @RequestParam(required=false) String cursor,@RequestParam(defaultValue="25") int limit,HttpServletRequest request) {
        return new LoginController.Envelope(sessions.authentications(bearer(request),request.getHeader("Origin"),cursor,limit),LoginController.requestId(request));
    }
    @GetMapping("/api/v1/sessions/security-events") public LoginController.Envelope securityEvents(
            @RequestParam(required=false) String cursor,@RequestParam(defaultValue="25") int limit,HttpServletRequest request) {
        return new LoginController.Envelope(sessions.securityEvents(bearer(request),request.getHeader("Origin"),cursor,limit),LoginController.requestId(request));
    }
    @PostMapping("/api/v1/sessions/authentications/{id}/revoke") public LoginController.Envelope revokeAuthentication(
            @PathVariable String id,@RequestBody Map<String,Object> body,HttpServletRequest request) {
        if(!body.isEmpty()) throw new LoginFailure(400,"INVALID_REQUEST");
        return new LoginController.Envelope(sessions.revokeAuthentication(bearer(request),request.getHeader("Origin"),id,LoginController.requestId(request)),LoginController.requestId(request));
    }
    @GetMapping("/api/v1/users/me") public LoginController.Envelope me(HttpServletRequest request) {
        return new LoginController.Envelope(sessions.me(bearer(request),request.getHeader("Origin")),LoginController.requestId(request));
    }
    @PostMapping("/api/v1/users/me/profile") public LoginController.Envelope profile(@RequestBody Map<String,Object> body,HttpServletRequest request) {
        if (!body.keySet().equals(java.util.Set.of("displayName","avatarUrl")) || !(body.get("displayName") instanceof String)
                || (body.get("avatarUrl") != null && !(body.get("avatarUrl") instanceof String))) throw new LoginFailure(400,"INVALID_REQUEST");
        return new LoginController.Envelope(sessions.updateProfile(bearer(request),request.getHeader("Origin"),
                (String)body.get("displayName"),(String)body.get("avatarUrl"),LoginController.requestId(request)),LoginController.requestId(request));
    }
    @PostMapping("/api/v1/sessions/current/logout") public LoginController.Envelope logout(
            @RequestBody Map<String,Object> body,HttpServletRequest request) { return revoke(body,request,false); }
    @PostMapping("/api/v1/sessions/logout-all") public LoginController.Envelope logoutAll(
            @RequestBody Map<String,Object> body,HttpServletRequest request) { return revoke(body,request,true); }
    private LoginController.Envelope revoke(Map<String,Object> body,HttpServletRequest request,boolean all) {
        if (!body.isEmpty()) throw new LoginFailure(400,"INVALID_REQUEST");
        sessions.logout(bearer(request),request.getHeader("Origin"),all,LoginController.requestId(request));
        return new LoginController.Envelope(Map.of("loggedOut",true),LoginController.requestId(request));
    }
    static String bearer(HttpServletRequest request) {
        var headers=Collections.list(request.getHeaders("Authorization"));
        if (headers.size()!=1) throw new LoginFailure(401,"UNAUTHENTICATED");
        var match=java.util.regex.Pattern.compile("(?i:Bearer) ([A-Za-z0-9_-]{43})").matcher(headers.getFirst());
        if (!match.matches()) throw new LoginFailure(401,"UNAUTHENTICATED");
        return match.group(1);
    }
}
