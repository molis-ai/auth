package ai.molis.auth.federation;

import ai.molis.auth.login.*;
import jakarta.servlet.http.*;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnProperty(name="auth.federation.enabled",havingValue="true")
final class ProviderContinuationController {
    private final ProviderMailboxContinuation continuation;
    private final ProviderLoginCoordinator login;
    ProviderContinuationController(ProviderMailboxContinuation continuation,ProviderLoginCoordinator login){this.continuation=continuation;this.login=login;}
    @PostMapping("/api/v1/auth/providers/continuation/{action}")
    LoginController.Envelope handle(@PathVariable String action,@RequestHeader(AuthHttpBoundary.TRANSACTION_HEADER) String tx,
            @RequestBody Map<String,Object> body,HttpServletRequest request,HttpServletResponse response) {
        Set<String> keys=switch(action){case "context","cancel"->Set.of("continuation");case "mailbox"->Set.of("continuation","email","locale");case "reauthenticate"->Set.of("continuation","provider","confirmed");case "link-password"->Set.of("continuation","password","confirmed");case "complete"->Set.of("continuation","challenge","locale","confirmed");default->throw new LoginFailure(400,"INVALID_REQUEST");};
        if(!body.keySet().equals(keys))throw new LoginFailure(400,"INVALID_REQUEST");
        String state=string(body,"continuation",43);if(!state.matches("[A-Za-z0-9_-]{43}"))throw new LoginFailure(400,"INVALID_REQUEST");
        String browser=ProviderHttpBoundary.rawCookies(request).get(ProviderHttpBoundary.cookieName(state));
        String locale=body.containsKey("locale")?string(body,"locale",5):"en";
        if(!Set.of("en","zh-CN").contains(locale))throw new LoginFailure(400,"INVALID_REQUEST");
        Object data=switch(action) {
            case "context"->continuation.context(state,browser,tx);
            case "reauthenticate"->{
                if(!Boolean.TRUE.equals(body.get("confirmed")))throw new LoginFailure(400,"INVALID_REQUEST");
                var provider=switch(string(body,"provider",6)){case "google"->IdentityProvider.GOOGLE;case "apple"->IdentityProvider.APPLE;default->throw new LoginFailure(400,"INVALID_REQUEST");};
                var started=login.reauthenticate(provider,state,browser,tx,request.getHeader("Origin"),request.getRemoteAddr());
                response.addHeader("Set-Cookie",ProviderController.cookie(started.state(),started.browserBinding(),300));
                yield Map.of("authorizationUrl",started.authorizationUrl().toASCIIString());
            }
            case "link-password"->{
                if(!Boolean.TRUE.equals(body.get("confirmed")))throw new LoginFailure(400,"INVALID_REQUEST");
                String url=continuation.linkPassword(state,browser,tx,string(body,"password",512),request.getRemoteAddr(),ProviderController.requestId(request));
                response.addHeader("Set-Cookie",ProviderController.cookie(state,"",0));yield Map.of("continueUrl",url);
            }
            case "mailbox"->continuation.request(state,browser,tx,string(body,"email",254),locale,request.getRemoteAddr(),ProviderController.requestId(request));
            case "complete"->{
                if(!Boolean.TRUE.equals(body.get("confirmed")))throw new LoginFailure(400,"INVALID_REQUEST");
                String url=continuation.complete(state,browser,tx,string(body,"challenge",43),locale,request.getRemoteAddr(),ProviderController.requestId(request));
                if(url==null)yield Map.of("linkRequired",true);
                response.addHeader("Set-Cookie",ProviderController.cookie(state,"",0));yield Map.of("continueUrl",url);
            }
            case "cancel"->{continuation.cancel(state,browser,tx);response.addHeader("Set-Cookie",ProviderController.cookie(state,"",0));yield Map.of("cancelled",true);}
            default->throw new LoginFailure(400,"INVALID_REQUEST");
        };
        return new LoginController.Envelope(data,ProviderController.requestId(request));
    }
    private static String string(Map<String,Object> body,String key,int max){if(!(body.get(key) instanceof String value)||value.isBlank()||value.length()>max)throw new LoginFailure(400,"INVALID_REQUEST");return value;}
}
