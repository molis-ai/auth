package ai.molis.auth.authorization;

import org.junit.jupiter.api.Test;
import static ai.molis.auth.authorization.SpaceRole.*;
import static org.assertj.core.api.Assertions.*;

class MembershipPolicyTests {
    private final MembershipPolicy policy = new MembershipPolicy();

    @Test
    void adminCannotManagePeersOrPromoteToAdmin() {
        assertThat(policy.canChangeRole(ADMIN, MEMBER, VIEWER, false, false)).isTrue();
        assertThat(policy.canChangeRole(ADMIN, VIEWER, MEMBER, false, false)).isTrue();
        assertThat(policy.canChangeRole(ADMIN, MEMBER, ADMIN, false, false)).isFalse();
        assertThat(policy.canChangeRole(ADMIN, ADMIN, MEMBER, false, false)).isFalse();
        assertThat(policy.canRemove(ADMIN, ADMIN, false)).isFalse();
        assertThat(policy.canRemove(ADMIN, OWNER, false)).isFalse();
        assertThat(policy.canRemove(ADMIN, MEMBER, false)).isTrue();
    }

    @Test
    void ownerCanManageNonOwnersButCannotUseRoleEditAsOwnershipTransfer() {
        assertThat(policy.canChangeRole(OWNER, MEMBER, ADMIN, false, false)).isTrue();
        assertThat(policy.canChangeRole(OWNER, ADMIN, MEMBER, false, false)).isTrue();
        assertThat(policy.canChangeRole(OWNER, MEMBER, OWNER, false, false)).isFalse();
        assertThat(policy.canChangeRole(OWNER, OWNER, ADMIN, false, false)).isFalse();
        assertThat(policy.canRemove(OWNER, OWNER, false)).isFalse();
        assertThat(policy.canRemove(OWNER, ADMIN, false)).isTrue();
    }

    @Test
    void archivedTeamBlocksInvitationAndRoleEditButAllowsRemovalExitAndHandoff() {
        assertThat(policy.canInvite(OWNER, true, false)).isFalse();
        assertThat(policy.canChangeRole(OWNER, MEMBER, ADMIN, true, false)).isFalse();
        assertThat(policy.canRemove(OWNER, MEMBER, false)).isTrue();
        assertThat(policy.canLeave(MEMBER, false)).isTrue();
        assertThat(policy.canLeave(OWNER, false)).isFalse();
        assertThat(policy.canRequestOwnershipTransfer(OWNER, VIEWER, false)).isTrue();
    }

    @Test
    void personalSpaceHasNoTeamManagementOperations() {
        assertThat(policy.canInvite(OWNER, false, true)).isFalse();
        assertThat(policy.canChangeRole(OWNER, MEMBER, ADMIN, false, true)).isFalse();
        assertThat(policy.canRemove(OWNER, MEMBER, true)).isFalse();
        assertThat(policy.canLeave(OWNER, true)).isFalse();
        assertThat(policy.canRequestOwnershipTransfer(OWNER, MEMBER, true)).isFalse();
    }

    @Test
    void ordinaryMembersAndMissingMembershipCannotManageOthers() {
        for (var actor : new SpaceRole[] {MEMBER, VIEWER, null}) {
            assertThat(policy.canInvite(actor, false, false)).isFalse();
            assertThat(policy.canRemove(actor, MEMBER, false)).isFalse();
            assertThat(policy.canChangeRole(actor, VIEWER, MEMBER, false, false)).isFalse();
            assertThat(policy.canRequestOwnershipTransfer(actor, MEMBER, false)).isFalse();
        }
        assertThat(policy.canLeave(null, false)).isFalse();
    }
}
