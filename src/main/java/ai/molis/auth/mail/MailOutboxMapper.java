package ai.molis.auth.mail;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface MailOutboxMapper {
    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            <script>
            SELECT id, recipient_email AS recipient, template_key AS template, locale, payload_encrypted AS payload,
                   expires_at AS expiresAt, attempts
            FROM auth_mail_outbox
            WHERE ((status = 'PENDING' AND next_attempt_at &lt;= CURRENT_TIMESTAMP(6))
                OR (status = 'SENDING' AND lease_until &lt;= CURRENT_TIMESTAMP(6)))
            <if test="id != null">AND id = #{id}</if>
            ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
            </script>
            """)
    Row lockNext(@Param("id") String id);

    @Insert("""
            INSERT INTO auth_mail_outbox(id, recipient_email, template_key, locale, payload_encrypted, expires_at,
                next_attempt_at, created_at)
            VALUES(#{id}, #{recipient}, #{template}, #{locale}, #{payload}, #{expiresAt}, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
            """)
    int enqueue(Row row);

    @Update("""
            UPDATE auth_mail_outbox SET status = 'SENDING', attempts = attempts + 1, lease_token = #{lease},
                lease_until = CURRENT_TIMESTAMP(6) + INTERVAL 60 SECOND WHERE id = #{id}
            """)
    int claim(@Param("id") String id, @Param("lease") String lease);

    @Update("""
            UPDATE auth_mail_outbox SET status = 'FAILED', lease_token = NULL, lease_until = NULL,
                payload_encrypted = NULL, last_error_code = #{code} WHERE id = #{id}
            """)
    int abandonLocked(@Param("id") String id, @Param("code") String code);

    @Update("""
            UPDATE auth_mail_outbox SET status = 'SENT', sent_at = CURRENT_TIMESTAMP(6), lease_token = NULL,
                lease_until = NULL, payload_encrypted = NULL, last_error_code = NULL
            WHERE id = #{id} AND status = 'SENDING' AND lease_token = #{lease}
            """)
    int sent(@Param("id") String id, @Param("lease") String lease);

    @Update("""
            UPDATE auth_mail_outbox SET status = #{status}, lease_token = NULL, lease_until = NULL,
                next_attempt_at = CURRENT_TIMESTAMP(6) + INTERVAL #{delaySeconds} SECOND, last_error_code = #{code},
                payload_encrypted = CASE WHEN #{status} = 'FAILED' THEN NULL ELSE payload_encrypted END
            WHERE id = #{id} AND status = 'SENDING' AND lease_token = #{lease}
            """)
    int failed(@Param("id") String id, @Param("lease") String lease, @Param("status") String status,
            @Param("code") String code, @Param("delaySeconds") int delaySeconds);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT COUNT(*) FROM auth_mail_outbox WHERE id = #{id} AND status = 'SENDING' AND lease_token = #{lease}
                AND lease_until > CURRENT_TIMESTAMP(6) AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(6))
            """)
    int ownsLiveLease(@Param("id") String id, @Param("lease") String lease);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT CURRENT_TIMESTAMP(6)")
    Instant databaseNow();

    record Row(String id, String recipient, String template, String locale, String payload, Instant expiresAt, int attempts) {
        public String context() {
            return String.join("\n", "auth-mail-v1", id, recipient, template, locale, expiresAt == null ? "" : expiresAt.toString());
        }
        @Override public String toString() { return "MailRow[id=" + id + ", template=" + template + ", payload=[REDACTED]]"; }
    }
}
