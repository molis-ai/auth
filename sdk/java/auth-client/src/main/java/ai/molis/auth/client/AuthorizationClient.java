package ai.molis.auth.client;

import java.util.List;

public interface AuthorizationClient {
    Decision check(String userAccessToken,String trustedSpaceId,String action,Resource resource);
    Actions allowedActions(String userAccessToken,String trustedSpaceId);
    SpacePage spaces(String userAccessToken,String action,String cursor,int limit);
    List<String> authorizedSpaceIds(String userAccessToken,String action,int maximumSpaces);
    /** Call only after a trusted user interaction, never from polling, refresh or background jobs. */
    default Activity recordUserActivity(String userAccessToken){throw new UnsupportedOperationException("Activity reporting is not implemented by this client");}
    record Activity(String requestId,String decisionId) {}
    default Decision requireAllowed(String userAccessToken,String trustedSpaceId,String action,Resource resource){
        var decision=check(userAccessToken,trustedSpaceId,action,resource);
        if(!decision.allowed())throw new AuthFailure(AuthFailure.Kind.DENIED,decision.requestId(),decision.decisionId());return decision;
    }
    record Resource(String type,String id) {}
    record Decision(boolean allowed,String reason,String requestId,String decisionId) {}
    record Actions(List<String> allowedActions,String role,String requestId,String decisionId) { public Actions {allowedActions=List.copyOf(allowedActions);} }
    record Space(String id,String name,String spaceType,String status,String role) {}
    record SpacePage(List<Space> spaces,String nextCursor,String requestId,String decisionId) { public SpacePage {spaces=List.copyOf(spaces);} }
}
