package ai.molis.auth.authorization;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.Collections;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/authorization")
public final class AuthorizationController {
    private static final String UUID_PATTERN="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final String ACTION_PATTERN="[a-z][a-z0-9_.]{0,99}";
    private final AuthorizationService authorizer;
    private final org.springframework.beans.factory.ObjectProvider<ai.molis.auth.verification.RedisRateLimiter> limiter;
    public AuthorizationController(AuthorizationService authorizer,org.springframework.beans.factory.ObjectProvider<ai.molis.auth.verification.RedisRateLimiter> limiter){this.authorizer=authorizer;this.limiter=limiter;}
    @PostMapping("/check") public ResponseEntity<?> check(@Valid @RequestBody Check body,HttpServletRequest request){
        if((body.resourceType()==null)!=(body.resourceId()==null))throw new IllegalArgumentException("Invalid resource context");
        return run(new AuthorizationService.Query(AuthorizationService.Operation.CHECK,body.spaceId().toLowerCase(),body.action(),body.resourceType(),body.resourceId(),null,0),request);
    }
    @PostMapping("/activity") public ResponseEntity<?> activity(@RequestBody Map<String,Object> body,HttpServletRequest request){
        if(!body.isEmpty())throw new IllegalArgumentException("Invalid activity");
        return run(new AuthorizationService.Query(AuthorizationService.Operation.ACTIVITY,null,null,null,null,null,0),request);
    }
    @PostMapping("/allowed-actions") public ResponseEntity<?> actions(@Valid @RequestBody Actions body,HttpServletRequest request){
        return run(new AuthorizationService.Query(AuthorizationService.Operation.ACTIONS,body.spaceId().toLowerCase(),null,null,null,null,0),request);
    }
    @PostMapping("/spaces") public ResponseEntity<?> spaces(@Valid @RequestBody Spaces body,HttpServletRequest request){
        return run(new AuthorizationService.Query(AuthorizationService.Operation.SPACES,null,body.action(),null,null,body.cursor()==null?null:body.cursor().toLowerCase(),body.limit()),request);
    }
    private ResponseEntity<?> run(AuthorizationService.Query query,HttpServletRequest request){
        var active=limiter.getIfAvailable();
        if(active==null)throw new ai.molis.auth.verification.EphemeralFailure(ai.molis.auth.verification.EphemeralFailure.Reason.UNAVAILABLE);
        active.acquire(ai.molis.auth.verification.RedisRateLimiter.Bucket.AUTHORIZATION_IP,request.getRemoteAddr());
        String service=single(request,"Authorization"),user=single(request,"X-User-Token");
        service=service!=null&&service.matches("(?i:Bearer) [A-Za-z0-9_-]{43}")?service.substring(7):null;
        user=user!=null&&user.matches("[A-Za-z0-9_-]{43}")?user:null;
        if(service!=null)active.acquire(ai.molis.auth.verification.RedisRateLimiter.Bucket.AUTHORIZATION_TOKEN,service);
        // A caller cannot turn either current bearer into a logged resource identifier.
        if(query.resourceId()!=null&&(query.resourceId().equals(service)||query.resourceId().equals(user)))throw new IllegalArgumentException("Invalid resource context");
        String requestId=(String)request.getAttribute(AuthorizationBoundary.REQUEST_ID),decisionId=(String)request.getAttribute(AuthorizationBoundary.DECISION_ID);
        var outcome=authorizer.execute(new AuthorizationService.Credentials(service,user),query,requestId,decisionId);
        if(outcome.error()!=null)return ResponseEntity.status(outcome.status()).body(error(outcome.error(),requestId,decisionId));
        return ResponseEntity.status(outcome.status()).body(Map.of("data",outcome.data(),"requestId",requestId));
    }
    static Map<String,Object> error(String code,String requestId,String decisionId){return Map.of("error",Map.of("code",code),"requestId",requestId,"decisionId",decisionId);}
    private static String single(HttpServletRequest request,String name){var values=Collections.list(request.getHeaders(name));return values.size()==1?values.getFirst():null;}
    public record Check(@NotNull @Pattern(regexp=UUID_PATTERN) String spaceId,@NotNull @Pattern(regexp=ACTION_PATTERN) String action,
            @Pattern(regexp="[a-z][a-z0-9_-]{0,31}") String resourceType,@Pattern(regexp="[A-Za-z0-9_.:-]{1,128}") String resourceId) {}
    public record Actions(@NotNull @Pattern(regexp=UUID_PATTERN) String spaceId) {}
    public record Spaces(@NotNull @Pattern(regexp=ACTION_PATTERN) String action,@Pattern(regexp=UUID_PATTERN) String cursor,@Min(1) @Max(200) Integer limit) {
        public Spaces {if(limit==null)limit=50;}
    }
}
