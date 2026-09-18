package ai.molis.auth.session;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface SessionMapper {
    String CONTEXT = """
            SELECT g.id AS sessionId, r.id AS authenticationId, r.user_id AS userId,
                   a.id AS applicationId, c.client_id AS clientId, u.status AS userStatus,
                   a.status AS applicationStatus, c.status AS clientStatus,
                   r.authenticated_at AS authenticatedAt, r.last_user_activity_at AS authenticationLastActivityAt,
                   r.revoked_at AS authenticationRevokedAt, g.last_user_activity_at AS lastUserActivityAt,
                   g.revoked_at AS revokedAt, g.issued_at AS issuedAt, g.authorized_scopes AS scopes,
            """;
    String JOINS = """
            FROM auth_authorization_session g
            JOIN auth_authentication_session r ON r.id = g.authentication_id
            JOIN auth_user u ON u.id = r.user_id
            JOIN auth_login_client c ON c.id = g.login_client_id
            JOIN auth_application a ON a.id = c.application_id
            """;

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT status FROM auth_user WHERE id = #{id} FOR UPDATE")
    String lockUser(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT c.id, c.client_id AS clientId, c.application_id AS applicationId,
                   c.status AS clientStatus, a.status AS applicationStatus, c.allowed_scopes AS allowedScopes, c.client_type AS clientType
            FROM auth_login_client c JOIN auth_application a ON a.id = c.application_id
            WHERE c.client_id = #{clientId} FOR SHARE
            """)
    ClientRow lockClient(String clientId);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT r.id, r.user_id AS userId, u.status AS userStatus, r.authenticated_at AS authenticatedAt,
                   r.last_user_activity_at AS lastUserActivityAt, r.revoked_at AS revokedAt
            FROM auth_authentication_session r JOIN auth_user u ON u.id = r.user_id WHERE r.id = #{id}
            """)
    AuthenticationRow findAuthentication(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT canonical_email FROM auth_user_email WHERE user_id = #{userId} ORDER BY canonical_email LIMIT 20")
    java.util.List<String> confirmationEmails(String userId);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT r.id, r.user_id AS userId, u.status AS userStatus, r.authenticated_at AS authenticatedAt,
                   r.last_user_activity_at AS lastUserActivityAt, r.revoked_at AS revokedAt
            FROM auth_authentication_session r JOIN auth_user u ON u.id = r.user_id WHERE r.id = #{id} FOR UPDATE
            """)
    AuthenticationRow lockAuthentication(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT r.id, r.user_id AS userId, u.status AS userStatus, r.authenticated_at AS authenticatedAt,
                   r.last_user_activity_at AS lastUserActivityAt, r.revoked_at AS revokedAt
            FROM auth_authentication_session r JOIN auth_user u ON u.id = r.user_id WHERE r.cookie_hash = #{hash}
            """)
    AuthenticationRow findCookie(String hash);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(CONTEXT + "NULL AS tokenExpiresAt, NULL AS tokenScopes " + JOINS + "WHERE g.id = #{id}")
    GrantRow findGrant(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT id FROM auth_authorization_session WHERE id = #{id} FOR UPDATE")
    String lockGrantRecord(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(CONTEXT + "t.expires_at AS tokenExpiresAt, t.scopes AS tokenScopes " + JOINS + """
            JOIN auth_user_token t ON t.session_id = g.id
            WHERE t.token_hash = #{hash} AND t.token_kind = 'ACCESS'
            """)
    GrantRow findAccess(String hash);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT token_hash AS tokenHash, session_id AS sessionId, token_kind AS tokenKind,
                   scopes, expires_at AS expiresAt, consumed_at AS consumedAt
            FROM auth_user_token WHERE token_hash = #{hash} AND token_kind = 'REFRESH'
            """)
    TokenRow findRefresh(String hash);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT token_hash AS tokenHash, session_id AS sessionId, token_kind AS tokenKind,
                   scopes, expires_at AS expiresAt, consumed_at AS consumedAt
            FROM auth_user_token WHERE token_hash = #{hash} AND token_kind = 'REFRESH' FOR UPDATE
            """)
    TokenRow lockRefresh(String hash);

    @Insert("""
            INSERT INTO auth_authentication_session(id, user_id, cookie_hash, authenticated_at, last_user_activity_at)
            VALUES(#{id}, #{userId}, #{cookieHash}, #{now}, #{now})
            """)
    int insertAuthentication(@Param("id") String id, @Param("userId") String userId,
            @Param("cookieHash") String cookieHash, @Param("now") Instant now);

    @Update("UPDATE auth_authentication_session SET cookie_hash = #{hash} WHERE id = #{id} AND cookie_hash IS NULL")
    int attachBrowserCookie(@Param("id") String id, @Param("hash") String hash);

    @Insert("""
            INSERT INTO auth_authorization_session(id, authentication_id, login_client_id,
                authorized_scopes, last_user_activity_at, created_at)
            VALUES(#{id}, #{authenticationId}, #{clientId}, #{scopes}, #{now}, #{now})
            """)
    int insertGrant(@Param("id") String id, @Param("authenticationId") String authenticationId,
            @Param("clientId") String clientId, @Param("scopes") String scopes, @Param("now") Instant now);

    @Insert("""
            INSERT INTO auth_user_token(token_hash, session_id, token_kind, scopes, issued_at, expires_at)
            VALUES(#{hash}, #{sessionId}, #{kind}, #{scopes}, #{now}, #{expiresAt})
            """)
    int insertToken(@Param("hash") String hash, @Param("sessionId") String sessionId,
            @Param("kind") String kind, @Param("scopes") String scopes,
            @Param("now") Instant now, @Param("expiresAt") Instant expiresAt);

    @Update("UPDATE auth_authorization_session SET issued_at = #{now} WHERE id = #{id} AND issued_at IS NULL")
    int markIssued(@Param("id") String id, @Param("now") Instant now);

    @Update("""
            UPDATE auth_user_token SET consumed_at = #{now}
            WHERE token_hash = #{hash} AND token_kind = 'REFRESH' AND consumed_at IS NULL
            """)
    int consumeRefresh(@Param("hash") String hash, @Param("now") Instant now);

    @Update("UPDATE auth_authorization_session SET revoked_at = COALESCE(revoked_at, #{now}) WHERE id = #{id}")
    int revokeGrant(@Param("id") String id, @Param("now") Instant now);

    @Update("""
            UPDATE auth_authorization_session g JOIN auth_authentication_session r ON r.id = g.authentication_id
            SET g.revoked_at = COALESCE(g.revoked_at, #{now}) WHERE r.user_id = #{userId}
            """)
    int revokeUserGrants(@Param("userId") String userId, @Param("now") Instant now);

    @Update("""
            UPDATE auth_authentication_session SET revoked_at = COALESCE(revoked_at, #{now}) WHERE user_id = #{userId}
            """)
    int revokeUserAuthentications(@Param("userId") String userId, @Param("now") Instant now);

    @Update("UPDATE auth_user SET status = 'DISABLED', updated_at = #{now} WHERE id = #{userId}")
    int disableUser(@Param("userId") String userId, @Param("now") Instant now);

    @Update("""
            UPDATE auth_authentication_session SET last_user_activity_at = GREATEST(last_user_activity_at, #{now})
            WHERE id = #{id}
            """)
    int touchAuthentication(@Param("id") String id, @Param("now") Instant now);

    @Update("""
            UPDATE auth_authorization_session SET last_user_activity_at = GREATEST(last_user_activity_at, #{now})
            WHERE id = #{id}
            """)
    int touchGrant(@Param("id") String id, @Param("now") Instant now);

    record ClientRow(String id, String clientId, String applicationId, String clientStatus,
                     String applicationStatus, String allowedScopes, String clientType) {}
    record AuthenticationRow(String id, String userId, String userStatus, Instant authenticatedAt,
                             Instant lastUserActivityAt, Instant revokedAt) {}
    record TokenRow(String tokenHash, String sessionId, String tokenKind, String scopes,
                    Instant expiresAt, Instant consumedAt) {}
    record GrantRow(String sessionId, String authenticationId, String userId, String applicationId,
                    String clientId, String userStatus, String applicationStatus, String clientStatus,
                    Instant authenticatedAt, Instant authenticationLastActivityAt, Instant authenticationRevokedAt,
                    Instant lastUserActivityAt, Instant revokedAt, Instant issuedAt, String scopes,
                    Instant tokenExpiresAt, String tokenScopes) {}
}
