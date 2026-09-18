package ai.molis.auth.session;

import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface SelfSecurityMapper {
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT id,provider FROM auth_external_identity WHERE user_id=#{user} ORDER BY id")
    List<ExternalMethod> externalMethods(String user);
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT COUNT(*) FROM auth_local_credential WHERE user_id=#{user}") int localMethods(String user);
    @Delete("DELETE FROM auth_external_identity WHERE user_id=#{user} AND id=#{id}")
    int unlink(@Param("user") String user,@Param("id") String id);
    record ExternalMethod(String id,String provider) {}
    // Explicit whitelist: never expose platform or space-management events through the account API.
    String OWN_EVENTS = "target_user_id = #{userId} AND (actor_user_id IS NULL OR actor_user_id = #{userId}) AND action IN "
            + "('account.register','account.login','account.password.reset','account.external.register','account.external.login','account.external.bind','account.external.unlink','session.logout.current','session.logout.all','session.authentication.revoke')";

    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT authenticated_at FROM auth_authentication_session WHERE user_id=#{userId} AND id=#{id}")
    Instant authenticationTime(@Param("userId") String userId,@Param("id") String id);

    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("""
            <script>
            SELECT r.id, r.authenticated_at AS authenticatedAt, r.last_user_activity_at AS lastUserActivityAt,
                   r.revoked_at AS revokedAt,
                   (SELECT COUNT(*) FROM auth_authorization_session g WHERE g.authentication_id=r.id AND g.issued_at IS NOT NULL) AS applicationSessionCount
            FROM auth_authentication_session r WHERE r.user_id=#{userId}
            <if test="time != null">AND (r.authenticated_at &lt; #{time} OR (r.authenticated_at=#{time} AND r.id &lt; #{cursor}))</if>
            ORDER BY r.authenticated_at DESC,r.id DESC LIMIT #{limit}
            </script>
            """)
    List<Authentication> authentications(@Param("userId") String userId,@Param("time") Instant time,@Param("cursor") String cursor,@Param("limit") int limit);

    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT id FROM auth_authentication_session WHERE user_id=#{userId} AND id=#{id} FOR UPDATE")
    String lockOwnedAuthentication(@Param("userId") String userId,@Param("id") String id);
    @Update("UPDATE auth_authentication_session SET revoked_at=#{now} WHERE user_id=#{userId} AND id=#{id} AND revoked_at IS NULL")
    int revokeAuthentication(@Param("userId") String userId,@Param("id") String id,@Param("now") Instant now);
    @Update("""
            UPDATE auth_authorization_session g JOIN auth_authentication_session r ON r.id=g.authentication_id
            SET g.revoked_at=COALESCE(g.revoked_at,#{now}) WHERE r.user_id=#{userId} AND r.id=#{id}
            """)
    int revokeChildren(@Param("userId") String userId,@Param("id") String id,@Param("now") Instant now);

    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,request_id,occurred_at,
                application_id,authorization_session_id,authentication_session_id)
            VALUES(#{id},'session.authentication.revoke','SUCCESS',#{userId},#{userId},#{requestId},#{now},#{app},#{grant},#{root})
            """)
    int auditRevocation(@Param("id") String id,@Param("userId") String userId,@Param("requestId") String requestId,
            @Param("now") Instant now,@Param("app") String app,@Param("grant") String grant,@Param("root") String root);

    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT occurred_at FROM auth_audit_event WHERE " + OWN_EVENTS + " AND id=#{id}")
    Instant eventTime(@Param("userId") String userId,@Param("id") String id);
    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("""
            <script>SELECT id,action,outcome,request_id AS requestId,occurred_at AS occurredAt,
                application_id AS applicationId,authorization_session_id AS authorizationSessionId,
                authentication_session_id AS authenticationSessionId
            FROM auth_audit_event WHERE
            """ + OWN_EVENTS + """
            <if test="time != null">AND (occurred_at &lt; #{time} OR (occurred_at=#{time} AND id &lt; #{cursor}))</if>
            ORDER BY occurred_at DESC,id DESC LIMIT #{limit}</script>
            """)
    List<Event> events(@Param("userId") String userId,@Param("time") Instant time,@Param("cursor") String cursor,@Param("limit") int limit);

    record Authentication(String id,Instant authenticatedAt,Instant lastUserActivityAt,Instant revokedAt,long applicationSessionCount) {}
    record Event(String id,String action,String outcome,String requestId,Instant occurredAt,String applicationId,
                 String authorizationSessionId,String authenticationSessionId) {}
}
