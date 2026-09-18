package ai.molis.auth.federation;

import java.time.Instant;
import org.apache.ibatis.annotations.*;

@Mapper
public interface ExternalAccountMapper {
    @Insert("INSERT INTO auth_external_mailbox_receipt(operation_id,verification_hash,completed_at) VALUES (#{operation},#{verification},#{now})")
    int mailboxReceipt(@Param("operation") String operation,@Param("verification") String verification,@Param("now") Instant now);
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("SELECT user_id AS userId,provider FROM auth_external_identity WHERE issuer=#{issuer} AND subject=#{subject}")
    Identity identity(@Param("issuer") String issuer,@Param("subject") String subject);
    @Insert("INSERT INTO auth_external_identity(id,user_id,provider,issuer,subject) VALUES (#{id},#{user},#{provider},#{issuer},#{subject})")
    int insert(@Param("id") String id,@Param("user") String user,@Param("provider") String provider,@Param("issuer") String issuer,@Param("subject") String subject);
    @Options(useCache=false,flushCache=Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT CONVERT(issuer USING utf8mb4) AS issuer,CONVERT(subject USING utf8mb4) AS subject,
                user_id AS userId,authentication_id AS authenticationId,registered
            FROM auth_external_login_receipt WHERE verification_hash=#{hash}
            """)
    Receipt receipt(String hash);
    @Insert("""
            INSERT INTO auth_external_login_receipt(verification_hash,issuer,subject,user_id,authentication_id,registered,completed_at)
            VALUES(#{hash},#{issuer},#{subject},#{user},#{root},#{registered},#{now})
            """)
    int receiptInsert(@Param("hash") String hash,@Param("issuer") String issuer,@Param("subject") String subject,
            @Param("user") String user,@Param("root") String root,@Param("registered") boolean registered,@Param("now") Instant now);
    record Identity(String userId,String provider) {}
    record Receipt(String issuer,String subject,String userId,String authenticationId,boolean registered) {}
}
