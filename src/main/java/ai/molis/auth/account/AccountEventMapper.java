package ai.molis.auth.account;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface AccountEventMapper {
    @Insert("""
            INSERT INTO auth_audit_event(id, action, outcome, actor_user_id, target_user_id, request_id, occurred_at)
            VALUES(#{id}, #{action}, #{outcome}, #{actor}, #{target}, #{requestId}, #{now})
            """)
    int audit(@Param("id") String id, @Param("action") String action, @Param("outcome") String outcome,
            @Param("actor") String actor, @Param("target") String target, @Param("requestId") String requestId,
            @Param("now") Instant now);

    @Insert("""
            INSERT INTO auth_mail_outbox(id, recipient_email, template_key, locale, next_attempt_at, created_at)
            VALUES(#{id}, #{email}, #{template}, #{locale}, #{now}, #{now})
            """)
    int mail(@Param("id") String id, @Param("email") String email, @Param("template") String template,
            @Param("locale") String locale, @Param("now") Instant now);
}
