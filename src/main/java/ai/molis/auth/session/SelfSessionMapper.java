package ai.molis.auth.session;

import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface SelfSessionMapper {
    @Select("SELECT avatar_data FROM auth_user WHERE id = #{userId}")
    String avatar(String userId);
    @Update("UPDATE auth_user SET display_name = #{name}, avatar_data = #{avatar} WHERE id = #{userId}")
    int updateProfile(@Param("userId") String userId, @Param("name") String name, @Param("avatar") String avatar);
    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT display_name FROM auth_user WHERE id = #{userId}")
    String displayName(String userId);
    @Options(useCache=false, flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT canonical_email FROM auth_user_email WHERE user_id = #{userId} ORDER BY canonical_email")
    List<String> emails(String userId);
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,request_id,occurred_at,application_id,authorization_session_id)
            VALUES(#{id},#{action},'SUCCESS',#{userId},#{userId},#{requestId},#{now},#{applicationId},#{sessionId})
            """)
    int audit(@Param("id") String id, @Param("action") String action, @Param("userId") String userId,
            @Param("requestId") String requestId, @Param("now") Instant now, @Param("applicationId") String applicationId,
            @Param("sessionId") String sessionId);
}
