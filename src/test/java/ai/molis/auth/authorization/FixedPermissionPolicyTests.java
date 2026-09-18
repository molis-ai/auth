package ai.molis.auth.authorization;

import java.util.Set;
import org.junit.jupiter.api.Test;
import static ai.molis.auth.authorization.SpaceRole.*;
import static ai.molis.auth.authorization.FixedPermissionPolicy.Denial.*;
import static org.assertj.core.api.Assertions.*;

class FixedPermissionPolicyTests {
    private final FixedPermissionPolicy policy = new FixedPermissionPolicy();
    private static final Set<String> READS = Set.of("space.read", "space.member.read", "role.read",
            "project.read", "goal.read", "session.read", "feed.read", "planning.read");

    @Test void applicationOverrideCannotBypassMembershipOrState(){
        assertThat(policy.evaluate(MEMBER,false,false,"feed.manage",true)).isEqualTo(NONE);
        assertThat(policy.evaluate(OWNER,false,false,"feed.read",false)).isEqualTo(ROLE_FORBIDDEN);
        assertThat(policy.evaluate(null,false,false,"feed.manage",true)).isEqualTo(NO_MEMBERSHIP);
        assertThat(policy.evaluate(MEMBER,true,false,"feed.manage",true)).isEqualTo(ARCHIVED_SPACE);
        assertThat(policy.evaluate(ADMIN,false,true,"feed.manage",true)).isEqualTo(PERSONAL_SPACE);
        assertThat(policy.evaluate(OWNER,false,false,"unknown.action",true)).isEqualTo(UNKNOWN_ACTION);
    }
    @Test
    void viewerCanReadIncludingFeedButCannotWrite() {
        assertThat(policy.allowedActions(VIEWER, false, false)).containsExactlyInAnyOrderElementsOf(READS);
        assertThat(policy.evaluate(VIEWER, false, false, "feed.manage")).isEqualTo(ROLE_FORBIDDEN);
    }

    @Test
    void memberHasOrdinaryWorkButNotApprovalDeletionOrFeedManagement() {
        assertThat(policy.allowedActions(MEMBER, false, false)).containsAll(READS)
                .contains("project.create", "project.update", "goal.advance", "session.manage", "planning.update")
                .hasSize(13);
        for (var action : Set.of("goal.approve", "project.delete", "feed.manage", "space.update", "space.archive")) {
            assertThat(policy.evaluate(MEMBER, false, false, action)).isEqualTo(ROLE_FORBIDDEN);
        }
    }

    @Test
    void adminAndOwnerHaveFixedManagementPermissions() {
        assertThat(policy.allowedActions(ADMIN, false, false))
                .contains("goal.approve", "project.delete", "feed.manage", "space.update")
                .doesNotContain("space.archive", "space.restore").hasSize(17);
        assertThat(policy.allowedActions(OWNER, false, false)).contains("space.archive", "space.restore").hasSize(19);
    }

    @Test
    void archiveRetainsReadButBlocksNormalWritesForEveryRole() {
        for (var role : SpaceRole.values()) {
            var actions = policy.allowedActions(role, true, false);
            if (role == OWNER) assertThat(actions).containsAll(READS).contains("space.restore").hasSize(9);
            else assertThat(actions).containsExactlyInAnyOrderElementsOf(READS);
        }
        assertThat(policy.evaluate(OWNER, true, false, "project.update")).isEqualTo(ARCHIVED_SPACE);
    }

    @Test
    void personalSpaceOnlyAllowsOwnerAndCannotBeArchivedSeparately() {
        assertThat(policy.allowedActions(ADMIN, false, true)).isEmpty();
        assertThat(policy.evaluate(OWNER, false, true, "space.archive")).isEqualTo(PERSONAL_SPACE);
        assertThat(policy.evaluate(OWNER, false, true, "space.restore")).isEqualTo(PERSONAL_SPACE);
        assertThat(policy.evaluate(OWNER, false, true, "project.create")).isEqualTo(NONE);
    }

    @Test
    void unknownOrMissingMembershipFailsClosedAndActionsCannotBeMutated() {
        assertThat(policy.evaluate(OWNER, false, false, "project.superpower")).isEqualTo(UNKNOWN_ACTION);
        assertThat(policy.evaluate(OWNER, false, false, null)).isEqualTo(UNKNOWN_ACTION);
        assertThat(policy.evaluate(null, false, false, "project.read")).isEqualTo(NO_MEMBERSHIP);
        assertThat(policy.allowedActions(null, false, false)).isEmpty();
        assertThatThrownBy(() -> policy.allowedActions(OWNER, false, false).add("made.up"))
                .isInstanceOf(UnsupportedOperationException.class);
        // Target-sensitive operations are intentionally not authorized by the generic catalogue.
        assertThat(policy.evaluate(OWNER, false, false, "space.member.remove")).isEqualTo(UNKNOWN_ACTION);
    }
}
