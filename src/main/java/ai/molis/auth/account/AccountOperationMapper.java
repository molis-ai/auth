package ai.molis.auth.account;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface AccountOperationMapper {
    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT u.id AS userId, u.status, c.password_hash AS passwordHash
            FROM auth_user_email e JOIN auth_user u ON u.id = e.user_id
            LEFT JOIN auth_local_credential c ON c.user_id = u.id WHERE e.canonical_email = #{email}
            """)
    CredentialRow findCredential(String email);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT password_hash FROM auth_local_credential WHERE user_id = #{userId} FOR UPDATE")
    String lockPassword(String userId);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT operation_id AS operationId, purpose, canonical_email AS email, user_id AS userId FROM auth_account_operation WHERE operation_id = #{id}")
    Receipt findReceipt(String id);

    @Insert("""
            INSERT INTO auth_account_operation(operation_id, purpose, canonical_email, user_id, completed_at)
            VALUES(#{id}, #{purpose}, #{email}, #{userId}, #{now})
            """)
    int receipt(@Param("id") String id, @Param("purpose") String purpose, @Param("email") String email,
            @Param("userId") String userId, @Param("now") Instant now);

    @Update("UPDATE auth_local_credential SET password_hash = #{hash}, changed_at = #{now} WHERE user_id = #{userId}")
    int changePassword(@Param("userId") String userId, @Param("hash") String hash, @Param("now") Instant now);

    record CredentialRow(String userId, String status, String passwordHash) {
        @Override public String toString() { return "CredentialRow[userId=" + userId + ", status=" + status + ", passwordHash=[REDACTED]]"; }
    }
    record Receipt(String operationId, String purpose, String email, String userId) {}
}
