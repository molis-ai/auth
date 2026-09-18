package ai.molis.example.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/demo/projects")
public class ProjectController {
    private final ProjectService projects;
    public ProjectController(ProjectService projects){this.projects=projects;}
    @GetMapping public Object list(HttpServletRequest request){String cursor=request.getParameter("cursor"),raw=request.getParameter("limit");
        if(cursor!=null)uuid(cursor);int limit=50;if(raw!=null){if(!raw.matches("[1-9][0-9]?")&&!raw.equals("100"))throw new DemoFailure(400,"INVALID_REQUEST");limit=Integer.parseInt(raw);}
        return projects.list(token(request),cursor,limit);}
    @GetMapping("/{id}") public Object read(@PathVariable String id,HttpServletRequest request){uuid(id);return projects.read(token(request),id);}
    @GetMapping("/{id}/actions") public Object actions(@PathVariable String id,HttpServletRequest request){uuid(id);return projects.actions(token(request),id);}
    @PutMapping("/{id}") public Object rename(@PathVariable String id,@Valid @RequestBody Rename body,HttpServletRequest request){uuid(id);
        if(!body.name().equals(body.name().strip())||body.name().codePoints().anyMatch(Character::isISOControl))throw new DemoFailure(400,"INVALID_REQUEST");
        return projects.rename(token(request),id,body.name(),body.version());}
    private static String token(HttpServletRequest request){return (String)request.getAttribute(DemoBoundary.USER_TOKEN);}
    private static void uuid(String value){if(!value.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"))throw new DemoFailure(400,"INVALID_REQUEST");}
    public record Rename(@NotBlank @Size(max=120) String name,@NotNull @Min(0) @Max(Long.MAX_VALUE-1) Long version){}
}
