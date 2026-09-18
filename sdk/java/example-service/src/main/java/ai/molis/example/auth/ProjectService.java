package ai.molis.example.auth;

import ai.molis.auth.client.AuthorizationClient;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProjectService {
    private final AuthorizationClient auth;private final ProjectMapper projects;
    public ProjectService(AuthorizationClient auth,ProjectMapper projects){this.auth=auth;this.projects=projects;}
    public ProjectMapper.Project read(String token,String id){var project=required(projects.find(id),token);auth.requireAllowed(token,project.spaceId(),"project.read",resource(id));return project;}
    public ActionView actions(String token,String id){var project=required(projects.find(id),token);auth.requireAllowed(token,project.spaceId(),"project.read",resource(id));
        var result=auth.allowedActions(token,project.spaceId());var actions=new ArrayList<>(result.allowedActions());
        if(!project.state().equals("EDITABLE"))actions.remove("project.update");return new ActionView(List.copyOf(actions),result.requestId(),result.decisionId());}
    @Transactional(readOnly=true)
    public Page list(String token,String cursor,int limit){
        // Gather the entire permitted scope (bounded/fail-closed); only then paginate and count business rows in SQL.
        var spaces=auth.authorizedSpaceIds(token,"project.read",1000);var rows=projects.page(spaces,cursor==null?"":cursor,limit+1);
        boolean more=rows.size()>limit;var items=List.copyOf(rows.subList(0,Math.min(rows.size(),limit)));return new Page(items,more?items.getLast().id():null,projects.count(spaces));
    }
    @Transactional
    public ProjectMapper.Project rename(String token,String id,String name,long version){
        // Trusted ownership and workflow state cannot change while this business row is locked.
        var project=required(projects.lock(id),token);auth.requireAllowed(token,project.spaceId(),"project.update",resource(id));
        if(!project.state().equals("EDITABLE"))throw new DemoFailure(409,"PROJECT_LOCKED");
        if(project.version()!=version||projects.rename(id,name,version)!=1)throw new DemoFailure(409,"VERSION_CONFLICT");return projects.find(id);
    }
    private ProjectMapper.Project required(ProjectMapper.Project project,String token){if(project==null){
        // Authenticate both identities even on a miss, so a forged token cannot probe resource existence via 401 vs 404.
        auth.spaces(token,"project.read",null,1);throw new DemoFailure(404,"NOT_FOUND");}return project;}
    private static AuthorizationClient.Resource resource(String id){return new AuthorizationClient.Resource("project",id);}
    public record ActionView(List<String> allowedActions,String requestId,String decisionId){}
    public record Page(List<ProjectMapper.Project> items,String nextCursor,long total){}
}
