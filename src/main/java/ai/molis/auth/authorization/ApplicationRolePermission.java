package ai.molis.auth.authorization;
public record ApplicationRolePermission(SpaceRole role,String action,boolean allowed) {}
