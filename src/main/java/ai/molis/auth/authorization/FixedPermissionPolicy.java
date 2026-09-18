package ai.molis.auth.authorization;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import static ai.molis.auth.authorization.SpaceRole.*;

/**
 * Role-level decisions only, not a public request authorization endpoint.
 * Caller must first validate user/session, service/application and load the membership
 * for this exact space. Workflow and target-member checks cannot be bypassed by this policy.
 */
public final class FixedPermissionPolicy {
    public enum Denial { NONE, UNKNOWN_ACTION, NO_MEMBERSHIP, ROLE_FORBIDDEN, PERSONAL_SPACE, ARCHIVED_SPACE }

    private enum Rule {
        SPACE_READ("space.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        MEMBER_READ("space.member.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        ROLE_READ("role.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        SPACE_UPDATE("space.update", false, false, OWNER, ADMIN),
        SPACE_ARCHIVE("space.archive", false, true, OWNER),
        SPACE_RESTORE("space.restore", true, true, OWNER),
        PROJECT_READ("project.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        PROJECT_CREATE("project.create", false, false, OWNER, ADMIN, MEMBER),
        PROJECT_UPDATE("project.update", false, false, OWNER, ADMIN, MEMBER),
        PROJECT_DELETE("project.delete", false, false, OWNER, ADMIN),
        GOAL_READ("goal.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        GOAL_ADVANCE("goal.advance", false, false, OWNER, ADMIN, MEMBER),
        GOAL_APPROVE("goal.approve", false, false, OWNER, ADMIN),
        SESSION_READ("session.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        SESSION_MANAGE("session.manage", false, false, OWNER, ADMIN, MEMBER),
        FEED_READ("feed.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        FEED_MANAGE("feed.manage", false, false, OWNER, ADMIN),
        PLANNING_READ("planning.read", true, false, OWNER, ADMIN, MEMBER, VIEWER),
        PLANNING_UPDATE("planning.update", false, false, OWNER, ADMIN, MEMBER);

        final String action;
        final boolean allowedWhileArchived;
        final boolean teamOnly;
        final Set<SpaceRole> roles;

        Rule(String action, boolean allowedWhileArchived, boolean teamOnly, SpaceRole... roles) {
            this.action = action;
            this.allowedWhileArchived = allowedWhileArchived;
            this.teamOnly = teamOnly;
            this.roles = Set.of(roles);
        }
    }

    private static final Map<String, Rule> RULES = Arrays.stream(Rule.values())
            .collect(Collectors.toUnmodifiableMap(rule -> rule.action, Function.identity()));

    public Denial evaluate(SpaceRole role, boolean archived, boolean personal, String action) {
        return evaluate(role,archived,personal,action,null);
    }

    public Denial evaluate(SpaceRole role, boolean archived, boolean personal, String action, Boolean granted) {
        if (action == null || !RULES.containsKey(action)) return Denial.UNKNOWN_ACTION;
        if (role == null) return Denial.NO_MEMBERSHIP;
        Rule rule = RULES.get(action);
        if (!(granted == null ? rule.roles.contains(role) : granted)) return Denial.ROLE_FORBIDDEN;
        // A personal space can only have its sole owner's membership.
        if (personal && (role != OWNER || rule.teamOnly)) return Denial.PERSONAL_SPACE;
        if (archived && !rule.allowedWhileArchived) return Denial.ARCHIVED_SPACE;
        return Denial.NONE;
    }

    public Set<String> allowedActions(SpaceRole role, boolean archived, boolean personal) {
        var result = new LinkedHashSet<String>();
        for (var rule : Rule.values()) {
            if (evaluate(role, archived, personal, rule.action) == Denial.NONE) result.add(rule.action);
        }
        return Collections.unmodifiableSet(result);
    }

    public Set<String> catalog() { return RULES.keySet(); }
}
