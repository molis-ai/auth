package ai.molis.auth.authorization;

import static ai.molis.auth.authorization.SpaceRole.*;

/** Target-aware management rules; database transactions still enforce current membership. */
public final class MembershipPolicy {
    public boolean canInvite(SpaceRole actor, boolean archived, boolean personal) {
        return !archived && !personal && (actor == OWNER || actor == ADMIN);
    }

    public boolean canChangeRole(SpaceRole actor, SpaceRole target, SpaceRole replacement,
            boolean archived, boolean personal) {
        if (archived || personal || target == null || replacement == null
                || target == OWNER || replacement == OWNER) return false;
        return actor == OWNER || actor == ADMIN
                && (target == MEMBER || target == VIEWER)
                && (replacement == MEMBER || replacement == VIEWER);
    }

    public boolean canRemove(SpaceRole actor, SpaceRole target, boolean personal) {
        if (personal || target == null || target == OWNER) return false;
        return actor == OWNER || actor == ADMIN && (target == MEMBER || target == VIEWER);
    }

    public boolean canLeave(SpaceRole actor, boolean personal) {
        return !personal && actor != null && actor != OWNER;
    }

    public boolean canRequestOwnershipTransfer(SpaceRole actor, SpaceRole target, boolean personal) {
        return !personal && actor == OWNER && target != null && target != OWNER;
    }
}
