package ai.molis.auth.platform;

import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api/v1/platform")
@ConditionalOnProperty(name="auth.login.enabled",havingValue="true")
public final class PlatformController {
    private final PlatformService service;
    public PlatformController(PlatformService service){this.service=service;}
    @GetMapping("/me") public Envelope me(HttpServletRequest r){return reply(service.me(caller(r)),r);}
    @GetMapping("/mail") public Envelope mail(HttpServletRequest r){return reply(service.mail(caller(r),r.getParameter("cursor"),limit(r)),r);}
    @PostMapping("/mail/{mail}/resend") public Envelope resend(@PathVariable String mail,HttpServletRequest r){body(r);return reply(service.resendMail(caller(r),mail),r);}
    @GetMapping("/permission-catalog") public Envelope catalog(HttpServletRequest r){return reply(service.catalog(caller(r)),r);}
    @GetMapping("/applications") public Envelope applications(HttpServletRequest r){return reply(service.applications(caller(r),r.getParameter("cursor"),limit(r)),r);}
    @PutMapping("/applications/{app}/permission-matrix") public Envelope savePermissionMatrix(@PathVariable String app,HttpServletRequest r){var b=body(r,"grants","version");return reply(service.savePermissionMatrix(caller(r),app,strings(b,"grants"),version(b)),r);}
    @GetMapping("/applications/{app}/permission-matrix") public Envelope permissionMatrix(@PathVariable String app,HttpServletRequest r){return reply(service.permissionMatrix(caller(r),app),r);}
    @GetMapping("/applications/{app}") public Envelope application(@PathVariable String app,HttpServletRequest r){return reply(service.application(caller(r),app),r);}
    @PostMapping("/applications") public Envelope createApplication(HttpServletRequest r){var b=body(r,"name","actions");return reply(service.createApplication(caller(r),string(b,"name"),strings(b,"actions")),r);}
    @PutMapping("/applications/{app}") public Envelope updateApplication(@PathVariable String app,HttpServletRequest r){var b=body(r,"name","status","actions","version");return reply(service.updateApplication(caller(r),app,string(b,"name"),string(b,"status"),strings(b,"actions"),version(b)),r);}
    @GetMapping("/applications/{app}/clients") public Envelope clients(@PathVariable String app,HttpServletRequest r){return reply(service.clients(caller(r),app,r.getParameter("cursor"),limit(r)),r);}
    @GetMapping("/clients/{client}") public Envelope client(@PathVariable String client,HttpServletRequest r){return reply(service.client(caller(r),client),r);}
    @PostMapping("/applications/{app}/clients") public Envelope createClient(@PathVariable String app,HttpServletRequest r){var b=body(r,"clientId","clientType","scopes","redirects");return reply(service.createClient(caller(r),app,string(b,"clientId"),string(b,"clientType"),strings(b,"scopes"),strings(b,"redirects")),r);}
    @PutMapping("/clients/{client}") public Envelope updateClient(@PathVariable String client,HttpServletRequest r){var b=body(r,"status","scopes","redirects","version");return reply(service.updateClient(caller(r),client,string(b,"status"),strings(b,"scopes"),strings(b,"redirects"),version(b)),r);}
    @GetMapping("/applications/{app}/services") public Envelope services(@PathVariable String app,HttpServletRequest r){return reply(service.serviceClients(caller(r),app,r.getParameter("cursor"),limit(r)),r);}
    @PostMapping("/applications/{app}/services") public Envelope createService(@PathVariable String app,HttpServletRequest r){var b=body(r,"name");return reply(service.createService(caller(r),app,string(b,"name")),r);}
    @PostMapping("/services/{client}/rotate") public Envelope rotate(@PathVariable String client,HttpServletRequest r){body(r);return reply(service.rotateService(caller(r),client),r);}
    @PostMapping("/services/{client}/disable") public Envelope disable(@PathVariable String client,HttpServletRequest r){body(r);return reply(service.disableService(caller(r),client),r);}
    @GetMapping("/users") public Envelope users(HttpServletRequest r){return reply(service.users(caller(r),r.getParameter("cursor"),limit(r)),r);}
    @GetMapping("/users/{user}") public Envelope user(@PathVariable String user,HttpServletRequest r){return reply(service.user(caller(r),user),r);}
    @PutMapping("/users/{user}/status") public Envelope userStatus(@PathVariable String user,HttpServletRequest r){var b=body(r,"status");return reply(service.userStatus(caller(r),user,string(b,"status")),r);}
    @GetMapping("/audit") public Envelope audit(HttpServletRequest r){return reply(service.auditEvents(caller(r),r.getParameter("cursor"),limit(r)),r);}
    private static JsonNode body(HttpServletRequest r,String...fields){var b=(JsonNode)r.getAttribute(PlatformBoundary.BODY);
        if(b==null||!b.isObject()||!Set.of(fields).equals(new HashSet<>(b.propertyNames())))throw invalid();return b;}
    private static String string(JsonNode b,String key){var n=b.path(key);if(!n.isString())throw invalid();return n.asText();}
    private static Set<String> strings(JsonNode b,String key){var n=b.path(key);if(!n.isArray()||n.size()>100)throw invalid();var values=new HashSet<String>();
        for(var item:n){if(!item.isString()||!values.add(item.asText()))throw invalid();}return Set.copyOf(values);}
    private static long version(JsonNode b){var n=b.path("version");if(!n.isIntegralNumber()||!n.canConvertToLong())throw invalid();return n.asLong();}
    private static int limit(HttpServletRequest r){String value=r.getParameter("limit");if(value==null)return 50;if(!value.matches("[1-9][0-9]{0,2}"))throw invalid();return Integer.parseInt(value);}
    private static PlatformService.Caller caller(HttpServletRequest r){var headers=Collections.list(r.getHeaders("Authorization"));String access=null;
        if(headers.size()==1){var matcher=java.util.regex.Pattern.compile("(?i:Bearer) ([A-Za-z0-9_-]{43})").matcher(headers.getFirst());if(matcher.matches())access=matcher.group(1);}
        return new PlatformService.Caller(access,(String)r.getAttribute(PlatformBoundary.REQUEST_ID));}
    private static Envelope reply(Object data,HttpServletRequest r){return new Envelope(data,(String)r.getAttribute(PlatformBoundary.REQUEST_ID));}
    private static PlatformFailure invalid(){return new PlatformFailure(400,"INVALID_REQUEST");}
    public record Envelope(Object data,String requestId){}
}
