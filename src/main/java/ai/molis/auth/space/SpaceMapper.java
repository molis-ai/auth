package ai.molis.auth.space;

import ai.molis.auth.authorization.SpaceRole;
import java.time.Instant;
import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface SpaceMapper {
    @Select("SELECT canonical_email FROM auth_user_email WHERE user_id=#{user} AND verified_at IS NOT NULL") List<String> verifiedEmails(String user);
    @Select("SELECT COUNT(*) FROM auth_membership WHERE space_id=#{id}") long memberCount(String id);
    @Select("""
            <script>
            SELECT s.id,s.name,s.space_type,s.status,s.version,m.role,
            (SELECT COUNT(*) FROM auth_membership members WHERE members.space_id=s.id) AS member_count,s.avatar_data AS avatar_url
            FROM auth_space s LEFT JOIN auth_membership m ON m.space_id=s.id AND m.user_id=#{user}
            WHERE s.space_type='TEAM'
            <if test="!platformAdmin">AND m.user_id=#{user}</if>
            <if test="filter.status != 'ALL'">AND s.status=#{filter.status}</if>
            <if test="filter.query != ''">AND LOCATE(#{filter.query},s.name)>0</if>
            <if test="filter.afterId != null">
              <choose><when test="filter.descending">AND (s.name &lt; #{filter.afterName} OR (s.name=#{filter.afterName} AND s.id &lt; #{filter.afterId}))</when>
              <otherwise>AND (s.name &gt; #{filter.afterName} OR (s.name=#{filter.afterName} AND s.id &gt; #{filter.afterId}))</otherwise></choose>
            </if>
            <choose><when test="filter.descending">ORDER BY s.name DESC,s.id DESC</when><otherwise>ORDER BY s.name,s.id</otherwise></choose>
            LIMIT #{limit}
            </script>
            """) List<View> teams(@Param("user") String user,@Param("platformAdmin") boolean platformAdmin,@Param("filter") TeamQuery filter,@Param("limit") int limit);
    @Select("SELECT CURRENT_TIMESTAMP(6)") Instant now();
    @Select("SELECT id,name,space_type,status,personal_user_id,version,description,avatar_data AS avatar_url FROM auth_space WHERE id=#{id} FOR UPDATE") Space lock(String id);
    @Select("SELECT role FROM auth_membership WHERE space_id=#{space} AND user_id=#{user}") SpaceRole role(@Param("space") String space,@Param("user") String user);
    @Select("SELECT status FROM auth_user WHERE id=#{id}") String userStatus(String id);
    @Select("SELECT display_name FROM auth_user WHERE id=#{id}") String userName(String id);
    @Select("SELECT u.display_name FROM auth_membership m JOIN auth_user u ON u.id=m.user_id WHERE m.space_id=#{space} AND m.role='OWNER' ORDER BY u.id LIMIT 1") String ownerName(String space);
    @Select("SELECT name FROM auth_space WHERE id=#{id}") String spaceName(String id);
    @Select("SELECT canonical_email FROM auth_user_email WHERE user_id=#{id} ORDER BY canonical_email") List<String> emails(String id);
    @Insert("INSERT INTO auth_space(id,name,space_type,status) VALUES(#{id},#{name},'TEAM','ACTIVE')") int create(@Param("id") String id,@Param("name") String name);
    @Update("UPDATE auth_space SET description=#{description},avatar_data=#{avatar} WHERE id=#{id}") int profile(@Param("id") String id,@Param("description") String description,@Param("avatar") String avatar);
    @Insert("INSERT INTO auth_membership(space_id,user_id,role) VALUES(#{space},#{user},#{role})") int add(@Param("space") String space,@Param("user") String user,@Param("role") SpaceRole role);
    @Update("UPDATE auth_membership SET role=#{role} WHERE space_id=#{space} AND user_id=#{user}") int changeRole(@Param("space") String space,@Param("user") String user,@Param("role") SpaceRole role);
    @Delete("DELETE FROM auth_membership WHERE space_id=#{space} AND user_id=#{user}") int remove(@Param("space") String space,@Param("user") String user);
    @Update("UPDATE auth_space SET name=#{name},status=#{status},version=version+1,updated_at=CURRENT_TIMESTAMP(6) WHERE id=#{id}") int update(@Param("id") String id,@Param("name") String name,@Param("status") String status);
    @Update("UPDATE auth_space SET version=version+1,updated_at=CURRENT_TIMESTAMP(6) WHERE id=#{id}") int changed(String id);
    @Select("""
            SELECT s.id,s.name,s.space_type,s.status,s.version,m.role,
            (SELECT COUNT(*) FROM auth_membership members WHERE members.space_id=s.id) AS member_count,s.avatar_data AS avatar_url
            FROM auth_space s JOIN auth_membership m ON m.space_id=s.id
            WHERE m.user_id=#{user} AND s.id > #{cursor} AND (s.space_type='TEAM' OR (s.personal_user_id=#{user} AND m.role='OWNER')) ORDER BY s.id LIMIT #{limit}
            """) List<View> spaces(@Param("user") String user,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("""
            SELECT u.id,u.display_name,u.status,m.role FROM auth_membership m JOIN auth_user u ON u.id=m.user_id
            WHERE m.space_id=#{space} AND u.id > #{cursor} ORDER BY u.id LIMIT #{limit}
            """) List<Member> members(@Param("space") String space,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("SELECT u.id FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE e.canonical_email=#{email} AND u.status='ACTIVE'") String invitationRecipient(String email);
    String INVITE="SELECT id,space_id,invited_email,inviter_user_id,status,accepted_by,created_at,expires_at,recipient_user_id FROM auth_space_invitation ";
    @Select(INVITE+"WHERE id=#{id}") Invitation invitation(String id);
    @Select("SELECT COUNT(*) FROM auth_space_invitation WHERE space_id=#{space}") long invitationCount(@Param("space") String space);
    @Select(INVITE+"WHERE space_id=#{space} ORDER BY created_at DESC,id DESC LIMIT #{limit} OFFSET #{offset}") List<Invitation> invitationDirectory(@Param("space") String space,@Param("limit") int limit,@Param("offset") long offset);
    @Select(INVITE+"WHERE space_id=#{space} AND invited_email=#{email} AND status='PENDING'") Invitation pendingInvite(@Param("space") String space,@Param("email") String email);
    @Select(INVITE+"WHERE space_id=#{space} AND id > #{cursor} ORDER BY id LIMIT #{limit}") List<Invitation> spaceInvitations(@Param("space") String space,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select(INVITE+"WHERE status='PENDING' AND expires_at>CURRENT_TIMESTAMP(6) AND recipient_user_id=#{user} AND id > #{cursor} ORDER BY id LIMIT #{limit}")
    List<Invitation> inbox(@Param("user") String user,@Param("cursor") String cursor,@Param("limit") int limit);
    @Insert("INSERT INTO auth_space_invitation(id,space_id,invited_email,inviter_user_id,status,created_at,expires_at,recipient_user_id) VALUES(#{id},#{spaceId},#{invitedEmail},#{inviterUserId},'PENDING',#{createdAt},#{expiresAt},#{recipientUserId})") int invite(Invitation invite);
    @Update("UPDATE auth_space_invitation SET status=#{status},accepted_by=#{user} WHERE id=#{id}") int invitationStatus(@Param("id") String id,@Param("status") String status,@Param("user") String user);
    @Select("SELECT occurred_at FROM auth_audit_event WHERE id=#{id} AND space_id=#{space}") Instant auditTime(@Param("id") String id,@Param("space") String space);
    @Select("""
            <script>SELECT id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,invitation_id,change_summary,denial_reason
            FROM auth_audit_event WHERE space_id=#{space}
            <if test="time != null">AND (occurred_at &lt; #{time} OR (occurred_at=#{time} AND id &lt; #{cursor}))</if>
            ORDER BY occurred_at DESC,id DESC LIMIT #{limit}</script>
            """) List<Audit> auditPage(@Param("space") String space,@Param("time") Instant time,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("SELECT COUNT(*) FROM auth_audit_event WHERE space_id=#{space}") long auditCount(@Param("space") String space);
    @Select("SELECT id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,invitation_id,change_summary,denial_reason FROM auth_audit_event WHERE space_id=#{space} ORDER BY occurred_at DESC,id DESC LIMIT #{limit} OFFSET #{offset}")
    List<Audit> auditDirectory(@Param("space") String space,@Param("limit") int limit,@Param("offset") long offset);
    @Insert("""
            INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,invitation_id,change_summary,denial_reason)
            VALUES(#{id},#{action},#{outcome},#{actorUserId},#{targetUserId},#{spaceId},#{requestId},#{occurredAt},#{invitationId},#{changeSummary},#{denialReason})
            """) int audit(Audit event);
    record Space(String id,String name,String spaceType,String status,String personalUserId,long version,String description,String avatarUrl){}
    record View(String id,String name,String spaceType,String status,long version,SpaceRole role,long memberCount,String avatarUrl){}
    record Member(String id,String displayName,String status,SpaceRole role){}
    String MEMBER_FILTER="FROM auth_membership m JOIN auth_user u ON u.id=m.user_id WHERE m.space_id=#{space} AND (#{query}='' OR LOCATE(#{query},u.display_name)>0 OR EXISTS(SELECT 1 FROM auth_user_email e WHERE e.user_id=u.id AND LOCATE(#{query},e.canonical_email)>0))";
    @Select("SELECT COUNT(*) "+MEMBER_FILTER) long filteredMemberCount(@Param("space") String space,@Param("query") String query);
    @Select("SELECT u.id,u.display_name,u.status,m.role "+MEMBER_FILTER+" ORDER BY CASE WHEN #{sort}='role' AND #{order}='desc' THEN CASE m.role WHEN 'OWNER' THEN 4 WHEN 'ADMIN' THEN 3 WHEN 'MEMBER' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END END DESC, CASE WHEN #{sort}='role' AND #{order}='asc' THEN CASE m.role WHEN 'OWNER' THEN 4 WHEN 'ADMIN' THEN 3 WHEN 'MEMBER' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END END ASC, CASE WHEN #{sort}='name' AND #{order}='desc' THEN u.display_name END DESC, u.display_name ASC,u.id ASC LIMIT #{limit} OFFSET #{offset}")
    List<Member> memberDirectory(@Param("space") String space,@Param("query") String query,@Param("limit") int limit,@Param("offset") long offset,@Param("sort") String sort,@Param("order") String order);
    @Select("""
            SELECT u.id,u.display_name,e.canonical_email AS email,
            EXISTS(SELECT 1 FROM auth_membership m WHERE m.space_id=#{space} AND m.user_id=u.id) AS joined,
            EXISTS(SELECT 1 FROM auth_space_invitation i WHERE i.space_id=#{space} AND i.recipient_user_id=u.id AND i.status='PENDING' AND i.expires_at>CURRENT_TIMESTAMP(6)) AS invited
            FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id
            WHERE u.status='ACTIVE' AND (LOCATE(#{query},u.display_name)>0 OR LOCATE(#{query},e.canonical_email)>0)
            ORDER BY u.display_name,u.id,e.canonical_email LIMIT 20
            """) List<InviteCandidate> inviteCandidates(@Param("space") String space,@Param("query") String query);
    record InviteCandidate(String id,String displayName,String email,boolean joined,boolean invited){}
    record Invitation(String id,String spaceId,String invitedEmail,String inviterUserId,String status,String acceptedBy,Instant createdAt,Instant expiresAt,String recipientUserId){}
    record Audit(String id,String action,String outcome,String actorUserId,String targetUserId,String spaceId,String requestId,Instant occurredAt,String invitationId,String changeSummary,String denialReason){}
}
