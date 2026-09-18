package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import jakarta.servlet.http.*;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnProperty(name="auth.federation.enabled",havingValue="true")
public final class ProviderController {
    private final ProviderLoginCoordinator login;
    public ProviderController(ProviderLoginCoordinator login){this.login=login;}
    @PostMapping("/api/v1/auth/providers/{provider}/bind")
    public LoginController.Envelope bind(@PathVariable String provider,@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String transaction,
            @RequestBody Map<String,Object> body,HttpServletRequest request,HttpServletResponse response){
        if(!body.isEmpty())throw new LoginFailure(400,"INVALID_REQUEST");
        var headers=java.util.Collections.list(request.getHeaders("Authorization"));
        if(headers.size()!=1||!headers.getFirst().matches("(?i:Bearer) [A-Za-z0-9_-]{43}"))throw new LoginFailure(401,"UNAUTHENTICATED");
        var selected=switch(provider){case "google"->IdentityProvider.GOOGLE;case "apple"->IdentityProvider.APPLE;default->throw new ExternalFailure("PROVIDER_NOT_ENABLED");};
        var started=login.bind(selected,transaction,request.getHeader("Origin"),request.getRemoteAddr(),headers.getFirst().substring(7));
        response.addHeader("Set-Cookie",cookie(started.state(),started.browserBinding(),300));
        return new LoginController.Envelope(Map.of("authorizationUrl",started.authorizationUrl().toASCIIString()),requestId(request));
    }
    @PostMapping("/api/v1/auth/providers/{provider}/start")
    public LoginController.Envelope start(@PathVariable String provider,@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String transaction,
            @RequestBody Map<String,Object> body,HttpServletRequest request,HttpServletResponse response) {
        if(!body.isEmpty())throw new LoginFailure(400,"INVALID_REQUEST");
        IdentityProvider selected=switch(provider){case "google"->IdentityProvider.GOOGLE;case "apple"->IdentityProvider.APPLE;default->throw new ExternalFailure("PROVIDER_NOT_ENABLED");};
        var started=login.begin(selected,transaction,request.getHeader("Origin"),request.getRemoteAddr());
        response.addHeader("Set-Cookie",cookie(started.state(),started.browserBinding(),300));
        // Never serialize Started: browserBinding belongs only in the HttpOnly cookie.
        return new LoginController.Envelope(Map.of("authorizationUrl",started.authorizationUrl().toASCIIString()),requestId(request));
    }
    @GetMapping("/oauth2/callback/google") public void google(HttpServletRequest request,HttpServletResponse response){complete(request,response);}
    @PostMapping("/oauth2/callback/apple") public void apple(HttpServletRequest request,HttpServletResponse response){complete(request,response);}
    private void complete(HttpServletRequest request,HttpServletResponse response) {
        if(!(request.getAttribute(ProviderHttpBoundary.PAYLOAD) instanceof ProviderHttpBoundary.Callback callback))throw new LoginFailure(400,"INVALID_REQUEST");
        boolean continuing=false;
        try {
            var finished=login.callback(callback.provider(),callback.state(),callback.binding(),callback.code(),callback.error(),
                    request.getLocale().getLanguage().equals("en")?"en":"zh-CN",requestId(request));
            response.setStatus(303);response.setHeader("Location",finished.continueUrl());
            continuing=finished.continuing();
            if(finished.completedContinuation()!=null)response.addHeader("Set-Cookie",cookie(finished.completedContinuation(),"",0));
            if(continuing)response.addHeader("Set-Cookie",cookie(callback.state(),callback.binding(),300));
        } finally { if(!continuing)response.addHeader("Set-Cookie",cookie(callback.state(),"",0)); }
    }
    static String cookie(String state,String value,long seconds) {
        return ResponseCookie.from(ProviderHttpBoundary.cookieName(state),value).httpOnly(true).secure(true).sameSite("None").path("/").maxAge(seconds).build().toString();
    }
    static String requestId(HttpServletRequest request){return (String)request.getAttribute(AuthHttpBoundary.REQUEST_ID);}
}
