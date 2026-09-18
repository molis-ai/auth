package ai.molis.example.auth;

import ai.molis.auth.client.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProjectServiceTests {
    final AuthorizationClient auth=mock(AuthorizationClient.class);final ProjectMapper mapper=mock(ProjectMapper.class);final ProjectService service=new ProjectService(auth,mapper);
    final ProjectMapper.Project project=new ProjectMapper.Project("project","trusted-space","Original","EDITABLE",0);
    @Test void usesStoredOwnershipAndNeverClientSuppliedSpace(){when(mapper.find("project")).thenReturn(project);assertEquals(project,service.read("token","project"));verify(auth).requireAllowed("token","trusted-space","project.read",new AuthorizationClient.Resource("project","project"));}
    @Test void unknownResourceStillRequiresBothValidIdentities(){when(auth.spaces("bad-token","project.read",null,1)).thenThrow(new AuthFailure(AuthFailure.Kind.USER_UNAUTHENTICATED));
        assertThrows(AuthFailure.class,()->service.read("bad-token","missing"));verify(auth).spaces("bad-token","project.read",null,1);}
    @Test void currentExecutionDenialPreventsWriteEvenAfterActionsWereShown(){when(mapper.find("project")).thenReturn(project);when(mapper.lock("project")).thenReturn(project);
        when(auth.allowedActions("token","trusted-space")).thenReturn(new AuthorizationClient.Actions(List.of("project.update"),"MEMBER","request","decision"));
        assertTrue(service.actions("token","project").allowedActions().contains("project.update"));
        doThrow(new AuthFailure(AuthFailure.Kind.DENIED)).when(auth).requireAllowed("token","trusted-space","project.update",new AuthorizationClient.Resource("project","project"));
        assertThrows(AuthFailure.class,()->service.rename("token","project","New",0));verify(mapper,never()).rename(anyString(),anyString(),anyLong());}
    @Test void sqlReceivesWholeScopeBeforePaginationAndSameScopeForCount(){var spaces=List.of("a","b");when(auth.authorizedSpaceIds("token","project.read",1000)).thenReturn(spaces);when(mapper.page(spaces,"",2)).thenReturn(List.of(project,new ProjectMapper.Project("second","b","Other","EDITABLE",0)));when(mapper.count(spaces)).thenReturn(2L);
        var result=service.list("token",null,1);assertEquals(List.of(project),result.items());assertEquals("project",result.nextCursor());assertEquals(2,result.total());verify(mapper).page(spaces,"",2);verify(mapper).count(spaces);}
    @Test void authFailureOrBusinessWorkflowNeverFallsBackToWrite(){when(mapper.lock("project")).thenReturn(new ProjectMapper.Project("project","trusted-space","Locked","LOCKED",0));
        assertThrows(DemoFailure.class,()->service.rename("token","project","New",0));verify(mapper,never()).rename(anyString(),anyString(),anyLong());
        when(auth.authorizedSpaceIds("token","project.read",1000)).thenThrow(new AuthFailure(AuthFailure.Kind.UNAVAILABLE));
        assertThrows(AuthFailure.class,()->service.list("token",null,1));verify(mapper,never()).page(anyList(),anyString(),anyInt());}
}
