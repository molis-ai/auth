package ai.molis.auth.session;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface AuthorizationCodeMapper {
    String COLUMNS = """
            SELECT code_hash AS codeHash, session_id AS sessionId,
                   authentication_transaction_id AS authenticationTransactionId,
                   redirect_uri AS redirectUri, pkce_challenge AS pkceChallenge,
                   issued_at AS issuedAt, expires_at AS expiresAt, consumed_at AS consumedAt
            FROM auth_authorization_code
            """;

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(COLUMNS + " WHERE code_hash = #{hash}")
    CodeRow find(String hash);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(COLUMNS + " WHERE code_hash = #{hash} FOR UPDATE")
    CodeRow lock(String hash);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT r.redirect_uri FROM auth_login_redirect r JOIN auth_login_client c ON c.id = r.client_id
            WHERE c.client_id = #{clientId} AND r.redirect_uri = #{redirectUri} FOR SHARE
            """)
    String lockRedirect(@Param("clientId") String clientId, @Param("redirectUri") String redirectUri);

    @Insert("""
            INSERT INTO auth_authorization_code(code_hash, session_id, authentication_transaction_id,
                redirect_uri, pkce_challenge, issued_at, expires_at)
            VALUES(#{hash}, #{sessionId}, #{transactionId}, #{redirectUri}, #{challenge}, #{now}, #{expiresAt})
            """)
    int insert(@Param("hash") String hash, @Param("sessionId") String sessionId,
            @Param("transactionId") String transactionId, @Param("redirectUri") String redirectUri,
            @Param("challenge") String challenge, @Param("now") Instant now, @Param("expiresAt") Instant expiresAt);

    @Update("UPDATE auth_authorization_code SET consumed_at = #{now} WHERE code_hash = #{hash} AND consumed_at IS NULL")
    int consume(@Param("hash") String hash, @Param("now") Instant now);

    record CodeRow(String codeHash, String sessionId, String authenticationTransactionId, String redirectUri,
                   String pkceChallenge, Instant issuedAt, Instant expiresAt, Instant consumedAt) {}
}
