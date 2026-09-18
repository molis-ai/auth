package ai.molis.auth.platform;

import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface PlatformMapper {
    @Select("SELECT role,action,allowed FROM auth_application_role_permission WHERE application_id=#{app}")
    List<ai.molis.auth.authorization.ApplicationRolePermission> rolePermissions(String app);

    @Delete("DELETE FROM auth_application_role_permission WHERE application_id=#{app}") int clearRolePermissions(String app);
    @Insert("INSERT INTO auth_application_role_permission(application_id,role,action,allowed) VALUES(#{app},#{role},#{action},#{allowed})")
    int addRolePermission(@Param("app") String app,@Param("role") String role,@Param("action") String action,@Param("allowed") boolean allowed);
    @Update("UPDATE auth_application SET version=version+1 WHERE id=#{app}") int bumpPermissionVersion(String app);
    @Delete("DELETE FROM auth_application_role_permission WHERE application_id=#{app} AND action NOT IN (SELECT action FROM auth_application_permission WHERE application_id=#{app})") int cleanRolePermissions(String app);

    @Select("SELECT COUNT(*) FROM auth_console_registration WHERE id='console' AND application_id=#{app}")
    int isConsoleApplication(String app);
    @Select("""
            SELECT m.id,m.recipient_email,m.template_key,m.locale,m.status,m.attempts,m.created_at,m.sent_at,
                   m.last_error_code,m.resend_of,r.id AS retry_id
            FROM auth_mail_outbox m LEFT JOIN auth_mail_outbox r ON r.resend_of=m.id
            WHERE m.id > #{cursor} ORDER BY m.id LIMIT #{limit}
            """)
    List<Mail> mailPage(@Param("cursor") String cursor,@Param("limit") int limit);
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT id,recipient_email,template_key,locale,status,attempts,created_at,sent_at,last_error_code,resend_of,
                   NULL AS retry_id FROM auth_mail_outbox WHERE id=#{id} FOR UPDATE
            """)
    Mail lockMail(String id);
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT id FROM auth_mail_outbox WHERE resend_of=#{id}") String mailRetry(String id);
    @Insert("""
            INSERT INTO auth_mail_outbox(id,recipient_email,template_key,locale,next_attempt_at,created_at,resend_of)
            SELECT #{retry},recipient_email,template_key,locale,CURRENT_TIMESTAMP(6),CURRENT_TIMESTAMP(6),id
            FROM auth_mail_outbox WHERE id=#{original} AND status='FAILED' AND resend_of IS NULL
                AND template_key IN ('ACCOUNT_REGISTERED','PASSWORD_CHANGED','SPACE_INVITED')
            """)
    int retryMail(@Param("original") String original,@Param("retry") String retry);
    record Mail(String id,String recipientEmail,String templateKey,String locale,String status,int attempts,
                Instant createdAt,Instant sentAt,String lastErrorCode,String resendOf,String retryId) {}
    @Select("SELECT id,name,status,version FROM auth_application WHERE id > #{cursor} ORDER BY id LIMIT #{limit}")
    List<Application> applications(@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("SELECT id,name,status,version FROM auth_application WHERE id=#{id}") Application application(String id);
    @Select("SELECT id,name,status,version FROM auth_application WHERE id=#{id} FOR UPDATE") Application lockApplication(String id);
    @Insert("INSERT INTO auth_application(id,name,status) VALUES(#{id},#{name},'ACTIVE')") int createApplication(@Param("id") String id,@Param("name") String name);
    @Update("UPDATE auth_application SET name=#{name},status=#{status},version=version+1 WHERE id=#{id}")
    int updateApplication(@Param("id") String id,@Param("name") String name,@Param("status") String status);
    @Select("SELECT action FROM auth_application_permission WHERE application_id=#{app} ORDER BY action") List<String> actions(String app);
    @Delete("DELETE FROM auth_application_permission WHERE application_id=#{app}") int clearActions(String app);
    @Insert("INSERT INTO auth_application_permission(application_id,action) VALUES(#{app},#{action})") int addAction(@Param("app") String app,@Param("action") String action);
    @Select("SELECT id,client_id,application_id,client_type,status,allowed_scopes,version FROM auth_login_client WHERE application_id=#{app} AND id > #{cursor} ORDER BY id LIMIT #{limit}")
    List<Client> clients(@Param("app") String app,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("SELECT id,client_id,application_id,client_type,status,allowed_scopes,version FROM auth_login_client WHERE client_id=#{client}") Client client(String client);
    @Select("SELECT id,client_id,application_id,client_type,status,allowed_scopes,version FROM auth_login_client WHERE client_id=#{client} FOR UPDATE") Client lockClient(String client);
    @Insert("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(#{id},#{client},#{app},#{type},'ACTIVE',#{scopes})")
    int createClient(@Param("id") String id,@Param("client") String client,@Param("app") String app,@Param("type") String type,@Param("scopes") String scopes);
    @Update("UPDATE auth_login_client SET status=#{status},allowed_scopes=#{scopes},version=version+1 WHERE id=#{id}")
    int updateClient(@Param("id") String id,@Param("status") String status,@Param("scopes") String scopes);
    @Select("SELECT redirect_uri FROM auth_login_redirect WHERE client_id=#{id} ORDER BY redirect_uri") List<String> redirects(String id);
    @Delete("DELETE FROM auth_login_redirect WHERE client_id=#{id}") int clearRedirects(String id);
    @Insert("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES(#{id},#{uri})") int addRedirect(@Param("id") String id,@Param("uri") String uri);
    @Update("""
            UPDATE auth_authorization_session g JOIN auth_login_client c ON c.id=g.login_client_id
            SET g.revoked_at=COALESCE(g.revoked_at,#{now}) WHERE c.application_id=#{app}
            """)
    int revokeApplicationGrants(@Param("app") String app,@Param("now") Instant now);
    @Update("UPDATE auth_authorization_session SET revoked_at=COALESCE(revoked_at,#{now}) WHERE login_client_id=#{id}")
    int revokeClientGrants(@Param("id") String id,@Param("now") Instant now);
    @Update("""
            UPDATE auth_service_credential k JOIN auth_service_client c ON c.id=k.service_client_id
            SET k.revoked_at=COALESCE(k.revoked_at,#{now}) WHERE c.application_id=#{app}
            """)
    int revokeApplicationServiceCredentials(@Param("app") String app,@Param("now") Instant now);
    @Select("SELECT id,display_name,status FROM auth_user WHERE id > #{cursor} ORDER BY id LIMIT #{limit}")
    List<User> users(@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("SELECT id,display_name,status FROM auth_user WHERE id=#{id}") User user(String id);
    @Select("SELECT canonical_email FROM auth_user_email WHERE user_id=#{id} ORDER BY canonical_email") List<String> emails(String id);
    @Update("UPDATE auth_user SET status=#{status},updated_at=#{now} WHERE id=#{id}") int userStatus(@Param("id") String id,@Param("status") String status,@Param("now") Instant now);
    @Select("""
            SELECT c.id,c.client_id,c.application_id,c.name,c.status,k.id AS active_credential_id
            FROM auth_service_client c LEFT JOIN auth_service_credential k ON k.service_client_id=c.id AND k.revoked_at IS NULL
            WHERE c.application_id=#{app} AND c.id > #{cursor} ORDER BY c.id LIMIT #{limit}
            """)
    List<ServiceClient> services(@Param("app") String app,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("""
            SELECT c.id,c.client_id,c.application_id,c.name,c.status,k.id AS active_credential_id
            FROM auth_service_client c LEFT JOIN auth_service_credential k ON k.service_client_id=c.id AND k.revoked_at IS NULL
            WHERE c.client_id=#{client}
            """) ServiceClient service(String client);
    @Select("SELECT occurred_at FROM auth_audit_event WHERE id=#{id}") Instant auditTime(String id);
    @Select("""
            <script>SELECT id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,application_id,
            actor_service_client_id,target_service_client_id,target_login_client_id,decision_id,requested_action,denial_reason,change_summary
            FROM auth_audit_event
            <if test="cursorTime != null">WHERE (occurred_at &lt; #{cursorTime} OR (occurred_at=#{cursorTime} AND id &lt; #{cursor}))</if>
            ORDER BY occurred_at DESC,id DESC LIMIT #{limit}</script>
            """)
    List<AuditView> auditPage(@Param("cursorTime") Instant cursorTime,@Param("cursor") String cursor,@Param("limit") int limit);
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,request_id,occurred_at,application_id,target_login_client_id,change_summary)
            VALUES(#{id},#{action},#{outcome},#{actor},#{user},#{request},#{now},#{app},#{client},#{summary})
            """)
    int audit(Audit event);
    record Application(String id,String name,String status,long version) {}
    record Client(String id,String clientId,String applicationId,String clientType,String status,String allowedScopes,long version) {}
    record User(String id,String displayName,String status) {}
    record ServiceClient(String id,String clientId,String applicationId,String name,String status,String activeCredentialId) {}
    record Audit(String id,String action,String outcome,String actor,String user,String request,Instant now,String app,String client,String summary) {}
    record AuditView(String id,String action,String outcome,String actorUserId,String targetUserId,String spaceId,String requestId,Instant occurredAt,
            String applicationId,String actorServiceClientId,String targetServiceClientId,String targetLoginClientId,String decisionId,String requestedAction,String denialReason,String changeSummary) {}
}
