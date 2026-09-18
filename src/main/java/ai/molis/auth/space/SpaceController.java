package ai.molis.auth.space;

import ai.molis.auth.authorization.SpaceRole;
import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api/v1")
@ConditionalOnProperty(name="auth.login.enabled",havingValue="true")
public final class SpaceController {
    private final SpaceService service;
    public SpaceController(SpaceService service){this.service=service;}
    @GetMapping("/spaces") public Envelope spaces(HttpServletRequest r){return reply(service.spaces(caller(r),r.getParameter("cursor"),limit(r)),r);}
    @GetMapping("/spaces/teams") public Envelope teams(HttpServletRequest r){return reply(service.teams(caller(r),r.getParameter("q"),r.getParameter("status"),r.getParameter("order"),r.getParameter("cursor"),limit(r)),r);}
    @PostMapping("/spaces") public Envelope create(HttpServletRequest r){
        var raw=(JsonNode)r.getAttribute(SpaceBoundary.BODY);
        boolean profile=raw!=null&&(raw.has("description")||raw.has("avatarUrl"));
        var b=profile?body(r,"name","description","avatarUrl"):body(r,"name");
        String avatar=profile&&!b.path("avatarUrl").isNull()?string(b,"avatarUrl"):null;
        return reply(service.create(caller(r),string(b,"name"),profile?string(b,"description"):"",avatar),r);
    }
    @GetMapping("/spaces/{space}") public Envelope detail(@PathVariable String space,HttpServletRequest r){return reply(service.detail(caller(r),space),r);}
    @PutMapping("/spaces/{space}") public Envelope update(@PathVariable String space,HttpServletRequest r){
        var raw=(JsonNode)r.getAttribute(SpaceBoundary.BODY);
        if(raw!=null&&(raw.has("description")||raw.has("avatarUrl"))){var b=body(r,"name","description","avatarUrl","version");return reply(service.updateProfile(caller(r),space,string(b,"name"),string(b,"description"),b.path("avatarUrl").isNull()?null:string(b,"avatarUrl"),version(b)),r);}
        var b=body(r,"name","version");return reply(service.update(caller(r),space,string(b,"name"),version(b)),r);
    }
    @PostMapping("/spaces/{space}/invite-candidates") public Envelope candidates(@PathVariable String space,HttpServletRequest r){var b=body(r,"query");return reply(service.inviteCandidates(caller(r),space,string(b,"query")),r);}
    @PutMapping("/spaces/{space}/archive") public Envelope archive(@PathVariable String space,HttpServletRequest r){var b=body(r,"archived","version");if(!b.path("archived").isBoolean())throw invalid();return reply(service.archive(caller(r),space,b.path("archived").asBoolean(),version(b)),r);}
    @GetMapping("/spaces/{space}/members") public Envelope members(@PathVariable String space,HttpServletRequest r){
        String page=r.getParameter("page");
        if(page!=null||r.getParameter("q")!=null||r.getParameter("sort")!=null||r.getParameter("order")!=null){if(r.getParameter("cursor")!=null||page!=null&&!page.matches("[1-9][0-9]{0,6}"))throw invalid();return reply(service.memberDirectory(caller(r),space,r.getParameter("q"),page==null?1:Integer.parseInt(page),limit(r),r.getParameter("sort"),r.getParameter("order")),r);}
        return reply(service.members(caller(r),space,r.getParameter("cursor"),limit(r)),r);
    }
    @PutMapping("/spaces/{space}/members/{user}/role") public Envelope role(@PathVariable String space,@PathVariable String user,HttpServletRequest r){var b=body(r,"role");return reply(service.role(caller(r),space,user,SpaceRole.valueOf(string(b,"role"))),r);}
    @PostMapping("/spaces/{space}/members/{user}/remove") public Envelope remove(@PathVariable String space,@PathVariable String user,HttpServletRequest r){body(r);return reply(service.remove(caller(r),space,user),r);}
    @PostMapping("/spaces/{space}/leave") public Envelope leave(@PathVariable String space,HttpServletRequest r){body(r);return reply(service.leave(caller(r),space),r);}
    @PostMapping("/spaces/{space}/invitations") public Envelope invite(@PathVariable String space,HttpServletRequest r){var b=body(r,"email","locale");return reply(service.invite(caller(r),space,string(b,"email"),string(b,"locale")),r);}
    @GetMapping("/spaces/{space}/invitations") public Envelope spaceInvitations(@PathVariable String space,HttpServletRequest r){String page=r.getParameter("page");if(page!=null){if(r.getParameter("cursor")!=null||!page.matches("[1-9][0-9]{0,6}"))throw invalid();return reply(service.invitationDirectory(caller(r),space,Integer.parseInt(page),limit(r)),r);}return reply(service.spaceInvitations(caller(r),space,r.getParameter("cursor"),limit(r)),r);}
    @PostMapping("/spaces/{space}/invitations/{invitation}/revoke") public Envelope revoke(@PathVariable String space,@PathVariable String invitation,HttpServletRequest r){body(r);return reply(service.revoke(caller(r),space,invitation),r);}
    @GetMapping("/invitations") public Envelope invitations(HttpServletRequest r){return reply(service.invitations(caller(r),r.getParameter("cursor"),limit(r)),r);}
    @GetMapping("/invitations/{invitation}") public Envelope invitation(@PathVariable String invitation,HttpServletRequest r){return reply(service.invitation(caller(r),invitation),r);}
    @PostMapping("/invitations/{invitation}/accept") public Envelope accept(@PathVariable String invitation,HttpServletRequest r){body(r);return reply(service.answer(caller(r),invitation,true),r);}
    @PostMapping("/invitations/{invitation}/decline") public Envelope decline(@PathVariable String invitation,HttpServletRequest r){body(r);return reply(service.answer(caller(r),invitation,false),r);}
    @GetMapping("/spaces/{space}/audit") public Envelope audit(@PathVariable String space,HttpServletRequest r){String page=r.getParameter("page");if(page!=null){if(r.getParameter("cursor")!=null||!page.matches("[1-9][0-9]{0,6}"))throw invalid();return reply(service.auditDirectory(caller(r),space,Integer.parseInt(page),limit(r)),r);}return reply(service.auditEvents(caller(r),space,r.getParameter("cursor"),limit(r)),r);}
    private static JsonNode body(HttpServletRequest r,String...fields){var b=(JsonNode)r.getAttribute(SpaceBoundary.BODY);if(b==null||!b.isObject()||!Set.of(fields).equals(new HashSet<>(b.propertyNames())))throw invalid();return b;}
    private static String string(JsonNode b,String field){var value=b.path(field);if(!value.isString())throw invalid();return value.asText();}
    private static long version(JsonNode b){var value=b.path("version");if(!value.isIntegralNumber()||!value.canConvertToLong())throw invalid();return value.asLong();}
    private static int limit(HttpServletRequest r){String value=r.getParameter("limit");if(value==null)return 50;if(!value.matches("[1-9][0-9]{0,2}"))throw invalid();return Integer.parseInt(value);}
    private static SpaceService.Caller caller(HttpServletRequest r){var headers=Collections.list(r.getHeaders("Authorization"));String token=null;
        if(headers.size()==1){var m=java.util.regex.Pattern.compile("(?i:Bearer) ([A-Za-z0-9_-]{43})").matcher(headers.getFirst());if(m.matches())token=m.group(1);}
        return new SpaceService.Caller(token,r.getHeader("Origin"),(String)r.getAttribute(SpaceBoundary.REQUEST_ID));}
    private static Envelope reply(Object data,HttpServletRequest r){return new Envelope(data,(String)r.getAttribute(SpaceBoundary.REQUEST_ID));}
    private static SpaceFailure invalid(){return new SpaceFailure(400,"INVALID_REQUEST");}
    public record Envelope(Object data,String requestId){}
}
