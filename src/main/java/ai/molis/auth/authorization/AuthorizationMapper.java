package ai.molis.auth.authorization;

import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface AuthorizationMapper {
    @Select("SELECT role,action,allowed FROM auth_application_role_permission WHERE application_id=#{app}")
    List<ai.molis.auth.authorization.ApplicationRolePermission> rolePermissions(String app);

    @Select("SELECT action FROM auth_application_permission WHERE application_id=#{app} ORDER BY action FOR SHARE")
    List<String> actions(String app);
    @Select("SELECT id,name,space_type,status,personal_user_id FROM auth_space WHERE id=#{id} FOR SHARE")
    Space lockSpace(String id);
    @Select("SELECT role FROM auth_membership WHERE space_id=#{space} AND user_id=#{user} FOR SHARE")
    SpaceRole membership(@Param("space") String space,@Param("user") String user);

    // The policy supplies enum-derived bound role values. All eligibility predicates precede LIMIT.
    @Select("""
            <script>
            SELECT s.id,s.name,s.space_type,s.status,m.role FROM auth_space s
            JOIN auth_membership m ON m.space_id=s.id
            WHERE m.user_id=#{user} AND s.id &gt; #{cursor} AND (
              (s.space_type='TEAM' AND s.status='ACTIVE' AND m.role IN
                <foreach collection="active" item="role" open="(" separator="," close=")">#{role}</foreach>)
              OR (s.space_type='TEAM' AND s.status='ARCHIVED' AND m.role IN
                <foreach collection="archived" item="role" open="(" separator="," close=")">#{role}</foreach>)
              OR (#{personal}=TRUE AND s.space_type='PERSONAL' AND s.status='ACTIVE' AND s.personal_user_id=#{user} AND m.role='OWNER')
            ) ORDER BY s.id LIMIT #{limit} FOR SHARE
            </script>
            """)
    List<SpaceItem> accessible(@Param("user") String user,@Param("cursor") String cursor,@Param("limit") int limit,
            @Param("active") List<String> active,@Param("archived") List<String> archived,@Param("personal") boolean personal);
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,
                application_id,authorization_session_id,actor_service_client_id,decision_id,requested_action,denial_reason,resource_type,resource_id)
            VALUES(#{id},#{operation},#{outcome},#{user},#{user},#{space},#{request},#{now},#{app},#{session},#{service},#{decision},#{action},#{reason},#{resourceType},#{resourceId})
            """)
    int audit(Audit event);
    record Space(String id,String name,String spaceType,String status,String personalUserId) {}
    record SpaceItem(String id,String name,String spaceType,String status,SpaceRole role) {}
    record Audit(String id,String operation,String outcome,String user,String space,String request,Instant now,
            String app,String session,String service,String decision,String action,String reason,String resourceType,String resourceId) {}
}
