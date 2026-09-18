package ai.molis.auth.service;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface ServiceIdentityMapper {
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,request_id,occurred_at,denial_reason)
            VALUES(#{id},'service.authentication','DENIED',#{request},#{now},#{reason})
            """)
    int authenticationDenied(@Param("id") String id,@Param("request") String request,@Param("now") Instant now,@Param("reason") String reason);
    @Select("SELECT id,client_id,application_id,name,status FROM auth_service_client WHERE client_id=#{clientId}")
    Client findClient(String clientId);
    @Select("SELECT status FROM auth_application WHERE id=#{id} FOR SHARE")
    String lockApplication(String id);
    @Select("SELECT id,client_id,application_id,name,status FROM auth_service_client WHERE id=#{id} FOR UPDATE")
    Client lockClient(String id);
    @Select("SELECT id,service_client_id,secret_hash,created_at,revoked_at FROM auth_service_credential WHERE service_client_id=#{client} AND secret_hash=#{hash}")
    Credential findCredential(@Param("client") String client,@Param("hash") String hash);
    @Select("SELECT id,service_client_id,secret_hash,created_at,revoked_at FROM auth_service_credential WHERE id=#{id}")
    Credential credential(String id);
    @Select("SELECT COUNT(*) FROM auth_login_client WHERE client_id=#{clientId}")
    int loginIdentifierCount(String clientId);
    @Insert("INSERT INTO auth_service_client(id,client_id,application_id,name,status,created_at) VALUES(#{id},#{clientId},#{applicationId},#{name},'ACTIVE',#{now})")
    int insertClient(@Param("id") String id,@Param("clientId") String clientId,@Param("applicationId") String applicationId,@Param("name") String name,@Param("now") Instant now);
    @Insert("INSERT INTO auth_service_credential(id,service_client_id,secret_hash,created_at) VALUES(#{id},#{client},#{hash},#{now})")
    int insertCredential(@Param("id") String id,@Param("client") String client,@Param("hash") String hash,@Param("now") Instant now);
    @Update("UPDATE auth_service_credential SET revoked_at=#{now} WHERE service_client_id=#{client} AND revoked_at IS NULL")
    int revokeCredentials(@Param("client") String client,@Param("now") Instant now);
    @Update("UPDATE auth_service_client SET status='DISABLED' WHERE id=#{id}")
    int disable(String id);
    @Insert("INSERT INTO auth_service_token(token_hash,credential_id,scope,issued_at,expires_at) VALUES(#{hash},#{credential},#{scope},#{issued},#{expires})")
    int insertToken(@Param("hash") String hash,@Param("credential") String credential,@Param("scope") String scope,@Param("issued") Instant issued,@Param("expires") Instant expires);
    @Select("""
            SELECT t.credential_id,c.client_id,t.scope,t.issued_at,t.expires_at FROM auth_service_token t
            JOIN auth_service_credential k ON k.id=t.credential_id JOIN auth_service_client c ON c.id=k.service_client_id
            WHERE t.token_hash=#{hash}
            """)
    Token findToken(String hash);
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,request_id,occurred_at,application_id,target_service_client_id,service_credential_id)
            VALUES(#{id},#{action},'SUCCESS',#{actor},#{request},#{now},#{app},#{client},#{credential})
            """)
    int audit(@Param("id") String id,@Param("action") String action,@Param("actor") String actor,@Param("request") String request,
            @Param("now") Instant now,@Param("app") String app,@Param("client") String client,@Param("credential") String credential);
    record Client(String id,String clientId,String applicationId,String name,String status) {}
    record Credential(String id,String serviceClientId,String secretHash,Instant createdAt,Instant revokedAt) {}
    record Token(String credentialId,String clientId,String scope,Instant issuedAt,Instant expiresAt) {}
}
