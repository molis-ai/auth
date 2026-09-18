package ai.molis.auth.persistence;

import ai.molis.auth.authorization.SpaceRole;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Options;

/**
 * Persistence operations, never controller endpoints. The verified-registration workflow
 * must execute user/email/credential/personal-space/owner insertion in one transaction.
 */
@Mapper
public interface AccountMapper {
    @org.apache.ibatis.annotations.Update("UPDATE auth_user_email SET canonical_email=#{email} WHERE user_id=#{user} AND canonical_email=#{oldEmail}")
    int renameDevelopmentEmail(@Param("user") String user, @Param("oldEmail") String oldEmail, @Param("email") String email);
    @org.apache.ibatis.annotations.Update("UPDATE auth_local_credential SET password_hash=#{hash},changed_at=CURRENT_TIMESTAMP(6) WHERE user_id=#{user}")
    int resetDevelopmentPassword(@Param("user") String user, @Param("hash") String hash);
    @org.apache.ibatis.annotations.Update("UPDATE auth_authentication_session SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP(6)) WHERE user_id=#{user}")
    int revokeDevelopmentSessions(@Param("user") String user);
    @Insert("INSERT INTO auth_user_email(id,user_id,canonical_email,verified_at) VALUES(#{id},#{user},#{email},NULL)")
    int insertUnverifiedEmail(@Param("id") String id,@Param("user") String user,@Param("email") String email);
    @Insert("""
            INSERT INTO auth_user(id, display_name, status) VALUES(#{id}, #{displayName}, 'ACTIVE')
            """)
    int insertUser(@Param("id") String id, @Param("displayName") String displayName);

    @Insert("""
            INSERT INTO auth_user_email(id, user_id, canonical_email, verified_at)
            VALUES(#{id}, #{userId}, #{canonicalEmail}, CURRENT_TIMESTAMP(6))
            """)
    int insertVerifiedEmail(@Param("id") String id, @Param("userId") String userId,
            @Param("canonicalEmail") String canonicalEmail);

    @Insert("""
            INSERT INTO auth_local_credential(user_id, password_hash) VALUES(#{userId}, #{passwordHash})
            """)
    int insertLocalCredential(@Param("userId") String userId, @Param("passwordHash") String passwordHash);

    @Insert("""
            INSERT INTO auth_space(id, name, space_type, status, personal_user_id)
            VALUES(#{spaceId}, #{name}, 'PERSONAL', 'ACTIVE', #{userId})
            """)
    int insertPersonalSpace(@Param("spaceId") String spaceId, @Param("userId") String userId,
            @Param("name") String name);

    @Insert("""
            INSERT INTO auth_membership(space_id, user_id, role) VALUES(#{spaceId}, #{userId}, #{role})
            """)
    int insertMembership(@Param("spaceId") String spaceId, @Param("userId") String userId,
            @Param("role") SpaceRole role);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT u.id, u.display_name AS displayName, u.status
            FROM auth_user u JOIN auth_user_email e ON e.user_id = u.id
            WHERE e.canonical_email = #{canonicalEmail} AND e.verified_at IS NOT NULL
            """)
    UserRow findByVerifiedEmail(@Param("canonicalEmail") String canonicalEmail);

    @Select("SELECT COUNT(*) FROM auth_user WHERE id = #{id}")
    int countUser(@Param("id") String id);

    record UserRow(String id, String displayName, String status) {}
}
