package ai.molis.auth.space;

import ai.molis.auth.AuthApplication;
import ai.molis.auth.mail.MailOutboxMapper;
import ai.molis.auth.session.SessionService;
import ai.molis.auth.verification.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Actual HTTP/MySQL. Test fixtures preverify accounts; only the Redis quota transport is replaced. */
@SpringBootTest(classes=AuthApplication.class,webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties={"auth.login.enabled=true","auth.ephemeral.enabled=false","auth.issuer=http://localhost:8080"})
class SpaceHttpIT {
    @Value("${local.server.port}") int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired SessionService sessions;
    @Autowired org.mybatis.spring.SqlSessionTemplate sql;
    @MockitoBean RedisRateLimiter limiter;
    @MockitoSpyBean SpaceMapper mapper;
    @MockitoSpyBean ai.molis.auth.platform.PlatformAdministrators administrators;
    @MockitoSpyBean MailOutboxMapper mail;
    @MockitoSpyBean ai.molis.auth.session.SessionMapper sessionMapper;
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private static final HttpClient HTTP=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private Actor owner;
    @BeforeEach void fixture(){owner=actor(Set.of("account"));}
    @Test void platformAdminCanReadTeamsWithoutMembershipOrWriteAccess()throws Exception{
        String name="Visibility-"+id();
        var first=data(post(owner,"spaces",Map.of("name",name+"-a"))).path("id").asText();
        var second=data(post(owner,"spaces",Map.of("name",name+"-b"))).path("id").asText();
        var admin=actor(Set.of("account"));var outsider=actor(Set.of("account"));
        doReturn(true).when(administrators).contains(admin.id());
        String query="spaces/teams?q="+name+"&limit=1";
        var page=data(get(admin,query));assertThat(page.path("items").size()).isEqualTo(1);
        assertThat(page.path("items").get(0).path("id").asText()).isEqualTo(first);
        String cursor=java.net.URLEncoder.encode(page.path("nextCursor").asText(),java.nio.charset.StandardCharsets.UTF_8);
        assertThat(data(get(admin,query+"&cursor="+cursor)).path("items").get(0).path("id").asText()).isEqualTo(second);
        assertThat(data(get(outsider,query)).path("items").size()).isZero();
        var detail=get(admin,"spaces/"+first);assertThat(detail.statusCode()).isEqualTo(200);
        assertThat(data(detail).path("role").isNull()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_membership WHERE space_id=? AND user_id=?",Integer.class,first,admin.id())).isZero();
        assertThat(get(outsider,"spaces/"+first).statusCode()).isEqualTo(403);
        assertThat(get(admin,"spaces/"+first+"/members?page=1").statusCode()).isEqualTo(200);
        assertThat(get(admin,"spaces/"+first+"/invitations?page=1").statusCode()).isEqualTo(200);
        assertThat(get(admin,"spaces/"+first+"/audit?page=1").statusCode()).isEqualTo(200);
        assertThat(put(admin,"spaces/"+first,Map.of("name","Changed","version",0)).statusCode()).isEqualTo(403);
        assertThat(data(detail).path("canInspectManagement").asBoolean()).isTrue();
        for(String endpoint:List.of("members","invitations","audit")) {
            assertThat(get(admin,"spaces/"+first+"/"+endpoint).statusCode()).isEqualTo(200);
            assertThat(get(outsider,"spaces/"+first+"/"+endpoint+"?page=1").statusCode()).isEqualTo(403);
        }
        assertThat(invite(admin,first,outsider.email()).statusCode()).isEqualTo(403);
        assertThat(post(admin,"spaces/"+first+"/members/"+owner.id()+"/remove",Map.of()).statusCode()).isEqualTo(403);
        assertThat(put(admin,"spaces/"+first+"/members/"+owner.id()+"/role",Map.of("role","MEMBER")).statusCode()).isEqualTo(403);
        String invitation=inviteId(owner,first,outsider.email());
        assertThat(post(admin,"spaces/"+first+"/invitations/"+invitation+"/revoke",Map.of()).statusCode()).isEqualTo(403);
        String personal=id();jdbc.update("INSERT INTO auth_space(id,name,space_type,status,personal_user_id) VALUES(?,'Personal','PERSONAL','ACTIVE',?)",personal,owner.id());add(personal,owner,"OWNER");
        assertThat(get(admin,"spaces/"+personal).statusCode()).isEqualTo(403);
    }
    @Test void invitationDirectoryPagesAndEnforcesManagementAccess()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));
        inviteId(owner,space,guest.email());inviteId(owner,space,actor(Set.of("account")).email());
        var response=get(owner,"spaces/"+space+"/invitations?page=1&limit=1");
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        var first=data(response);assertThat(first.path("total").asInt()).isEqualTo(2);
        assertThat(first.path("pageSize").asInt()).isEqualTo(1);assertThat(first.path("items").size()).isEqualTo(1);
        var second=data(get(owner,"spaces/"+space+"/invitations?page=2&limit=1"));
        assertThat(second.path("items").get(0).path("id").asText()).isNotEqualTo(first.path("items").get(0).path("id").asText());
        assertThat(data(get(owner,"spaces/"+space+"/invitations?page=999&limit=1")).path("page").asInt()).isEqualTo(2);
        assertThat(get(owner,"spaces/"+space+"/invitations?page=0&limit=1").statusCode()).isEqualTo(400);
        assertThat(get(owner,"spaces/"+space+"/invitations?page=1&cursor=x").statusCode()).isEqualTo(400);
        add(space,guest,"MEMBER");assertThat(get(guest,"spaces/"+space+"/invitations?page=1&limit=1").statusCode()).isEqualTo(403);
    }
    @Test void teamProfileIsPersistedAndValidatesOptionalFields()throws Exception{
        var bytes=new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(128,128,java.awt.image.BufferedImage.TYPE_INT_RGB),"png",bytes);
        String avatar="data:image/png;base64,"+Base64.getEncoder().encodeToString(bytes.toByteArray());
        var response=post(owner,"spaces",Map.of("name","Profile team","description","产品与研发\n团队","avatarUrl",avatar));
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        String space=data(response).path("id").asText();
        var detail=data(get(owner,"spaces/"+space));
        assertThat(detail.path("description").asText()).isEqualTo("产品与研发\n团队");
        assertThat(detail.path("avatarUrl").asText()).startsWith("data:image/png;base64,");
        assertThat(detail.path("memberCount").asInt()).isEqualTo(1);
        assertThat(detail.path("role").asText()).isEqualTo("OWNER");
        assertThat(detail.path("ownerName").asText()).isEqualTo(jdbc.queryForObject("SELECT display_name FROM auth_user WHERE id=?",String.class,owner.id()));
        var reader=actor(Set.of("account"));add(space,reader,"MEMBER");
        assertThat(data(get(reader,"spaces/"+space)).path("ownerName").asText()).isEqualTo(detail.path("ownerName").asText());
        var listing=get(owner,"spaces/teams?q=Profile");assertThat(listing.statusCode()).as(listing.body()).isEqualTo(200);
        assertThat(data(listing).path("items").get(0).path("avatarUrl").asText()).isEqualTo(detail.path("avatarUrl").asText());
        assertThat(get(owner,"spaces").statusCode()).isEqualTo(200);
        assertThat(post(owner,"spaces",Map.of("name","Bad avatar","description","","avatarUrl","https://example.com/a.png")).statusCode()).isEqualTo(400);
        assertThat(post(owner,"spaces",Map.of("name","Bad description","description","x".repeat(201),"avatarUrl",avatar)).statusCode()).isEqualTo(400);
        assertThat(get(actor(Set.of("account")),"spaces/"+space).statusCode()).isEqualTo(403);
    }
    @Test void teamProfileEditsAreVersionedAndPermissionChecked()throws Exception{
        String space=team(owner);long version=data(get(owner,"spaces/"+space)).path("version").asLong();
        var edit=new HashMap<String,Object>();edit.put("name","Updated team");edit.put("description","Updated description");edit.put("avatarUrl",null);edit.put("version",version);
        var response=put(owner,"spaces/"+space,edit);assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        assertThat(data(response).path("description").asText()).isEqualTo("Updated description");
        assertThat(data(response).path("version").asLong()).isEqualTo(version+1);
        assertThat(put(owner,"spaces/"+space,edit).statusCode()).isEqualTo(409);
        var member=actor(Set.of("account"));add(space,member,"MEMBER");edit.put("version",version+1);
        assertThat(put(member,"spaces/"+space,edit).statusCode()).isEqualTo(403);
        edit.put("description","x".repeat(201));assertThat(put(owner,"spaces/"+space,edit).statusCode()).isEqualTo(400);
        edit.put("description","valid");edit.put("avatarUrl","https://example.com/avatar.png");assertThat(put(owner,"spaces/"+space,edit).statusCode()).isEqualTo(400);
        assertThat(data(get(owner,"spaces/"+space)).path("description").asText()).isEqualTo("Updated description");
        edit.put("avatarUrl",null);
        assertThat(put(owner,"spaces/"+space+"/archive",Map.of("archived",true,"version",version+1)).statusCode()).isEqualTo(200);
        edit.put("version",version+2);assertThat(put(owner,"spaces/"+space,edit).statusCode()).isEqualTo(403);
    }
    @Test void invitationSearchIsBoundedAndRequiresManagementPermission()throws Exception{
        String space=team(owner);var candidate=actor(Set.of("account"));String path="spaces/"+space+"/invite-candidates";
        var query=Map.of("query",candidate.email());var response=post(owner,path,query);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);assertThat(data(response)).hasSize(1);
        assertThat(data(response).get(0).path("email").asText()).isEqualTo(candidate.email());
        assertThat(data(response).get(0).path("joined").asBoolean()).isFalse();
        assertThat(post(candidate,path,query).statusCode()).isEqualTo(403);
        add(space,candidate,"MEMBER");assertThat(post(candidate,path,query).statusCode()).isEqualTo(403);
        assertThat(data(post(owner,path,query)).get(0).path("joined").asBoolean()).isTrue();
        var invited=actor(Set.of("account"));invite(owner,space,invited.email());
        assertThat(data(post(owner,path,Map.of("query",invited.email()))).get(0).path("invited").asBoolean()).isTrue();
        assertThat(post(owner,path,Map.of("query","a")).statusCode()).isEqualTo(400);
        assertThat(post(owner,path,Map.of("query","%_")).statusCode()).isEqualTo(200);
        assertThat(data(post(owner,path,Map.of("query","%_")))).isEmpty();
        verify(limiter,atLeastOnce()).acquire(RedisRateLimiter.Bucket.SPACE_SEARCH_USER,owner.id());
    }
    @Test void memberDirectorySearchPaginationEmailsAndPermissionsAreScoped()throws Exception{
        String space=team(owner),path="spaces/"+space+"/members";var expected=new HashSet<String>();expected.add(owner.id());
        Actor viewer=null;
        for(int i=0;i<13;i++){var user=actor(Set.of("account"));jdbc.update("UPDATE auth_user SET display_name=? WHERE id=?","Directory "+String.format("%02d",i),user.id());add(space,user,i==0?"VIEWER":i==1?"ADMIN":"MEMBER");expected.add(user.id());if(i==0)viewer=user;}
        var found=new HashSet<String>();
        for(int page=1;page<=2;page++){var response=get(owner,path+"?page="+page+"&limit=10&q=");assertThat(response.statusCode()).as(response.body()).isEqualTo(200);var value=data(response);assertThat(value.path("total").asInt()).isEqualTo(14);assertThat(value.path("page").asInt()).isEqualTo(page);assertThat(value.path("items")).hasSize(page==1?10:4);value.path("items").forEach(m->{assertThat(found.add(m.path("id").asText())).isTrue();assertThat(m.path("emails")).isNotEmpty();});}
        assertThat(found).containsExactlyInAnyOrderElementsOf(expected);
        assertThat(data(get(owner,path+"?page=1&limit=1")).path("items").get(0).path("role").asText()).isEqualTo("OWNER");
        assertThat(data(get(owner,path+"?page=2&limit=1&sort=role&order=desc")).path("items").get(0).path("role").asText()).isEqualTo("ADMIN");
        assertThat(data(get(owner,path+"?page=1&limit=1&sort=role&order=asc")).path("items").get(0).path("role").asText()).isEqualTo("VIEWER");
        assertThat(data(get(owner,path+"?page=1&q=Directory&sort=name&order=asc")).path("items").get(0).path("displayName").asText()).isEqualTo("Directory 00");
        assertThat(data(get(owner,path+"?page=1&q=Directory&sort=name&order=desc")).path("items").get(0).path("displayName").asText()).isEqualTo("Directory 12");
        assertThat(get(owner,path+"?sort=unknown").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?sort=name&sort=role").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?order=invalid").statusCode()).isEqualTo(400);
        assertThat(data(get(owner,path+"?page=999&limit=10")).path("page").asInt()).isEqualTo(2);
        var result=data(get(viewer,path+"?page=1&q="+viewer.email()));assertThat(result.path("total").asInt()).isEqualTo(1);
        var row=result.path("items").get(0);assertThat(row.path("emails").get(0).asText()).isEqualTo(viewer.email());
        var grants=row.path("permissions");assertThat(grants.path("actions").toString()).contains("feed.read").doesNotContain("feed.manage");assertThat(grants.path("invite").asBoolean()).isFalse();
        var admin=data(get(owner,path+"?page=1&q=Directory%2001")).path("items").get(0).path("permissions");assertThat(admin.path("invite").asBoolean()).isTrue();assertThat(admin.path("editableRoles").toString()).contains("MEMBER","VIEWER").doesNotContain("ADMIN","OWNER");
        jdbc.update("INSERT INTO auth_user_email(id,canonical_email,user_id,verified_at) VALUES(?,?,?,CURRENT_TIMESTAMP(6))",id(),"alternate-"+viewer.id()+"@example.test",viewer.id());
        result=data(get(owner,path+"?page=1&q=alternate-"+viewer.id()));assertThat(result.path("total").asInt()).isEqualTo(1);assertThat(result.path("items").get(0).path("emails")).hasSize(2);
        assertThat(data(get(owner,path+"?page=1&q=%25_")).path("total").asInt()).isZero();
        var outsider=actor(Set.of("account"));assertThat(get(outsider,path+"?page=1").statusCode()).isEqualTo(403);
        assertThat(get(owner,path+"?page=0").statusCode()).isEqualTo(400);assertThat(get(owner,path+"?page=1&page=2").statusCode()).isEqualTo(400);assertThat(get(owner,path+"?page=1&cursor="+owner.id()).statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?page=1&limit=101").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?limit=5").statusCode()).isEqualTo(200);
        long version=data(get(owner,"spaces/"+space)).path("version").asLong();put(owner,"spaces/"+space+"/archive",Map.of("archived",true,"version",version));
        var archived=data(get(owner,path+"?page=1&q=Directory%2001")).path("items").get(0).path("permissions");assertThat(archived.path("invite").asBoolean()).isFalse();assertThat(archived.path("actions").toString()).doesNotContain("space.update","feed.manage");
    }
    @Test void teamDirectorySearchSortAndKeysetPaginationAreMembershipScoped()throws Exception{
        var expected=new ArrayList<String>();
        for(int i=0;i<31;i++){
            String space=id(),name=i<3?"Same":"Team "+String.format("%02d",i);
            jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,?,'TEAM','ACTIVE')",space,name);
            add(space,owner,"MEMBER"); expected.add(space);
        }
        String archived=id();jdbc.update("INSERT INTO auth_space(id,name,space_type,status) VALUES(?,'Literal %_','TEAM','ARCHIVED')",archived);add(archived,owner,"VIEWER");expected.add(archived);
        var outsider=actor(Set.of("account"));team(outsider);
        var ascending=new ArrayList<String>();var descending=new ArrayList<String>();
        for(String order:List.of("asc","desc")){
            var found=order.equals("asc")?ascending:descending;String cursor=null;int pages=0;
            do{
                var response=get(owner,"spaces/teams?limit=7&order="+order+(cursor==null?"":"&cursor="+cursor));
                assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
                var result=data(response);result.path("items").forEach(item->{assertThat(item.path("spaceType").asText()).isEqualTo("TEAM");found.add(item.path("id").asText());});
                cursor=result.path("nextCursor").isNull()?null:result.path("nextCursor").asText();assertThat(++pages).isLessThan(10);
            }while(cursor!=null);
            assertThat(found).hasSize(expected.size()).doesNotHaveDuplicates().containsExactlyInAnyOrderElementsOf(expected);
        }
        Collections.reverse(ascending);assertThat(descending).containsExactlyElementsOf(ascending);
        assertThat(data(get(owner,"spaces/teams?q=%25_&status=ARCHIVED")).path("items")).hasSize(1);
        assertThat(data(get(owner,"spaces/teams?q=Same&status=ACTIVE")).path("items")).hasSize(3);
        assertThat(data(get(outsider,"spaces/teams?q=Same")).path("items")).isEmpty();
        assertThat(get(owner,"spaces/teams?order=bad").statusCode()).isEqualTo(400);
        assertThat(get(owner,"spaces/teams?cursor=invalid").statusCode()).isEqualTo(400);
        assertThat(get(owner,"spaces/teams?q=a&q=b").statusCode()).isEqualTo(400);
    }
    @AfterAll static void close(){HTTP.close();}
    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry p){
        p.add("spring.datasource.url",()->{String url=System.getProperty("auth.it.jdbc-url","");if(!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?"))throw new IllegalArgumentException("Disposable local database required");return url;});
        p.add("spring.datasource.username",()->System.getenv().getOrDefault("AUTH_TEST_DB_USER","root"));p.add("spring.datasource.password",()->System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD",""));
    }
    @Test void auditNumberedPagesAreScopedAndValidated()throws Exception{
        String space=team(owner),path="spaces/"+space+"/audit";
        put(owner,"spaces/"+space,Map.of("name","Audit paging","version",0));
        var first=get(owner,path+"?page=1&limit=1");assertThat(first.statusCode()).as(first.body()).isEqualTo(200);
        var page=data(first);assertThat(page.path("total").asInt()).isEqualTo(2);assertThat(page.path("pageSize").asInt()).isEqualTo(1);
        assertThat(page.path("items").get(0).path("action").asText()).isEqualTo("space.update");
        var second=data(get(owner,path+"?page=2&limit=1"));assertThat(second.path("items").get(0).path("action").asText()).isEqualTo("space.create");
        assertThat(data(get(owner,path+"?page=999&limit=1")).path("page").asInt()).isEqualTo(2);
        assertThat(get(owner,path+"?page=0").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?page=1&page=2").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?page=1&cursor="+owner.id()).statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?page=1&limit=101").statusCode()).isEqualTo(400);
        assertThat(get(owner,path+"?limit=1").statusCode()).isEqualTo(200);
        var guest=actor(Set.of("account"));add(space,guest,"MEMBER");
        assertThat(get(guest,path+"?page=1").statusCode()).isEqualTo(403);
        assertThat(get(actor(Set.of("account")),path+"?page=1").statusCode()).isEqualTo(403);
    }
    @Test void teamCreationIsAtomicAndStartsWithOnlyItsVerifiedOwner()throws Exception{
        String space=team(owner);assertThat(role(space,owner.id())).isEqualTo("OWNER");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_membership WHERE space_id=?",Integer.class,space)).isEqualTo(1);
        assertThat(data(get(owner,"spaces/"+space)).path("spaceType").asText()).isEqualTo("TEAM");
        verify(limiter).acquire(RedisRateLimiter.Bucket.SPACE_CREATE_USER,owner.id());
        doThrow(new DataAccessResourceFailureException("private audit detail")).when(mapper).audit(any());
        String name="Rollback team "+id();var failed=post(owner,"spaces",Map.of("name",name));assertThat(failed.statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_space WHERE name=?",Integer.class,name)).isZero();
    }
    @Test void permissionDetailsReflectCurrentRoleAndArchiveState()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));
        String invitation=data(invite(owner,space,guest.email())).path("id").asText();
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(200);
        var permissions=data(get(guest,"spaces/"+space)).path("permissionDetails");
        var rules=new java.util.HashMap<String,JsonNode>();permissions.forEach(p->rules.put(p.path("action").asText(),p));
        assertThat(rules.keySet()).containsExactlyInAnyOrderElementsOf(new ai.molis.auth.authorization.FixedPermissionPolicy().catalog());
        assertThat(rules.get("feed.read").path("allowed").asBoolean()).isTrue();
        assertThat(rules.get("feed.manage").path("reason").asText()).isEqualTo("ROLE_FORBIDDEN");
        long version=data(get(owner,"spaces/"+space)).path("version").asLong();
        assertThat(put(owner,"spaces/"+space+"/archive",Map.of("archived",true,"version",version)).statusCode()).isEqualTo(200);
        var archived=data(get(guest,"spaces/"+space)).path("permissionDetails");
        archived.forEach(p->{if("project.create".equals(p.path("action").asText()))assertThat(p.path("reason").asText()).isEqualTo("ARCHIVED_SPACE");});
    }
    @Test void unverifiedAccountsReceiveInAppInvitationsWithoutMailAndJoinAsMember()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));jdbc.update("UPDATE auth_user_email SET verified_at=NULL WHERE user_id=?",guest.id());var response=invite(owner,space,guest.email());
        assertThat(response.statusCode()).isEqualTo(200);String invitation=data(response).path("id").asText();
        assertThat(role(space,guest.id())).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=? AND template_key='SPACE_INVITED'",Integer.class,guest.email())).isZero();
        assertThat(data(get(guest,"invitations")).path("items").toString()).contains(invitation,"Test team");
        assertThat(get(guest,"invitations/"+invitation).statusCode()).isEqualTo(200);assertThat(role(space,guest.id())).isNull();
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(200);assertThat(role(space,guest.id())).isEqualTo("MEMBER");
        assertThat(post(owner,"spaces/"+space+"/invitations",Map.of("email",guest.email(),"locale","en","role","ADMIN")).statusCode()).isEqualTo(400);
        verify(limiter).acquire(RedisRateLimiter.Bucket.SPACE_INVITE_USER,owner.id());verify(limiter).acquire(RedisRateLimiter.Bucket.MAIL_EMAIL,guest.email());
    }
    @Test void recipientAccountAndExplicitAcceptanceAreRequiredEvenIfEmailChanges()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));var stranger=actor(Set.of("account"));String invitation=inviteId(owner,space,guest.email());
        assertThat(get(stranger,"invitations/"+invitation).statusCode()).isEqualTo(404);
        assertThat(post(stranger,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(404);
        assertThat(data(get(stranger,"invitations")).path("items").toString()).doesNotContain(invitation);
        assertThat(send("POST","invitations/"+invitation+"/accept",null,Map.of(),Map.of("Cookie","auth_session_dev="+guest.root().cookieSecret())).statusCode()).isEqualTo(401);
        jdbc.update("DELETE FROM auth_user_email WHERE user_id=?",guest.id());
        jdbc.update("INSERT INTO auth_user_email(id,user_id,canonical_email,verified_at) VALUES(?,?,?,NULL)",id(),stranger.id(),guest.email());
        assertThat(post(stranger,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(404);
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(200);assertThat(role(space,guest.id())).isEqualTo("MEMBER");
    }
    @Test void duplicateInvitationsAndConcurrentAcceptanceDoNotDuplicateMailOrMembership()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));String invitation=inviteId(owner,space,guest.email());
        assertThat(inviteId(owner,space,guest.email().toUpperCase(Locale.ROOT))).isEqualTo(invitation);
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var a=executor.submit(()->post(guest,"invitations/"+invitation+"/accept",Map.of()));var b=executor.submit(()->post(guest,"invitations/"+invitation+"/accept",Map.of()));
            assertThat(a.get(12,TimeUnit.SECONDS).statusCode()).isEqualTo(200);assertThat(b.get(12,TimeUnit.SECONDS).statusCode()).isEqualTo(200);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_membership WHERE space_id=? AND user_id=?",Integer.class,space,guest.id())).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=? AND template_key='SPACE_INVITED'",Integer.class,guest.email())).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_audit_event WHERE invitation_id=? AND action='space.invitation.accept' AND outcome='SUCCESS'",Integer.class,invitation)).isEqualTo(1);
    }
    @Test void replayCannotRejoinRemovedMembersOrDowngradeExistingRoles()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));String invitation=inviteId(owner,space,guest.email());post(guest,"invitations/"+invitation+"/accept",Map.of());
        assertThat(post(owner,"spaces/"+space+"/members/"+guest.id()+"/remove",Map.of()).statusCode()).isEqualTo(200);
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(200);assertThat(role(space,guest.id())).isNull();
        add(space,guest,"ADMIN");String another=inviteId(owner,space,guest.email());post(guest,"invitations/"+another+"/accept",Map.of());assertThat(role(space,guest.id())).isEqualTo("ADMIN");
    }
    @Test void roleAndRemovalEnforceTheTargetAwareAdminBoundaryAndPreserveOwner()throws Exception{
        String space=team(owner);var admin=actor(Set.of("account"));var otherAdmin=actor(Set.of("account"));var member=actor(Set.of("account"));add(space,admin,"ADMIN");add(space,otherAdmin,"ADMIN");add(space,member,"MEMBER");
        assertThat(changeRole(admin,space,member,"VIEWER").statusCode()).isEqualTo(200);
        assertThat(changeRole(admin,space,member,"ADMIN").statusCode()).isEqualTo(403);assertThat(changeRole(admin,space,otherAdmin,"MEMBER").statusCode()).isEqualTo(403);
        assertThat(post(admin,"spaces/"+space+"/members/"+otherAdmin.id()+"/remove",Map.of()).statusCode()).isEqualTo(403);
        assertThat(changeRole(owner,space,member,"ADMIN").statusCode()).isEqualTo(200);
        assertThat(changeRole(owner,space,member,"OWNER").statusCode()).isEqualTo(403);assertThat(changeRole(owner,space,owner,"MEMBER").statusCode()).isEqualTo(403);
        assertThat(post(owner,"spaces/"+space+"/members/"+owner.id()+"/remove",Map.of()).statusCode()).isEqualTo(403);
        assertThat(post(owner,"spaces/"+space+"/leave",Map.of()).statusCode()).isEqualTo(403);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_membership WHERE space_id=? AND role='OWNER'",Integer.class,space)).isEqualTo(1);
    }
    @Test void archiveRetainsReadButBlocksInvitationAcceptanceAndRoleChangesWhileAllowingExit()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));var member=actor(Set.of("account"));add(space,member,"MEMBER");String invitation=inviteId(owner,space,guest.email());
        assertThat(put(owner,"spaces/"+space+"/archive",Map.of("archived",true,"version",0)).statusCode()).isEqualTo(200);
        assertThat(get(member,"spaces/"+space).statusCode()).isEqualTo(200);assertThat(get(member,"spaces/"+space+"/members").statusCode()).isEqualTo(200);
        assertThat(invite(owner,space,id()+"@example.test").statusCode()).isEqualTo(403);assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(403);
        assertThat(changeRole(owner,space,member,"VIEWER").statusCode()).isEqualTo(403);
        assertThat(post(member,"spaces/"+space+"/leave",Map.of()).statusCode()).isEqualTo(200);assertThat(get(member,"spaces/"+space).statusCode()).isEqualTo(403);
        long version=data(get(owner,"spaces/"+space)).path("version").asLong();assertThat(put(owner,"spaces/"+space+"/archive",Map.of("archived",false,"version",version)).statusCode()).isEqualTo(200);
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(200);
    }
    @Test void personalSpaceCannotBeRenamedArchivedInvitedOrLeftThroughTeamOperations()throws Exception{
        String space=id();jdbc.update("INSERT INTO auth_space(id,name,space_type,status,personal_user_id) VALUES(?,'Personal','PERSONAL','ACTIVE',?)",space,owner.id());add(space,owner,"OWNER");
        assertThat(get(owner,"spaces/"+space).statusCode()).isEqualTo(200);
        assertThat(put(owner,"spaces/"+space,Map.of("name","Changed","version",0)).statusCode()).isEqualTo(403);
        assertThat(put(owner,"spaces/"+space+"/archive",Map.of("archived",true,"version",0)).statusCode()).isEqualTo(403);
        assertThat(invite(owner,space,id()+"@example.test").statusCode()).isEqualTo(403);assertThat(post(owner,"spaces/"+space+"/leave",Map.of()).statusCode()).isEqualTo(403);
        var other=actor(Set.of("account"));add(space,other,"VIEWER");assertThat(get(other,"spaces/"+space).statusCode()).isEqualTo(403);
        assertThat(data(get(other,"spaces")).path("items").toString()).doesNotContain(space);
    }
    @Test void inviterDemotionOrDisableAndRevocationOrExpiryPreventAcceptance()throws Exception{
        String space=team(owner);var admin=actor(Set.of("account"));add(space,admin,"ADMIN");var guest=actor(Set.of("account"));String invitation=inviteId(admin,space,guest.email());
        changeRole(owner,space,admin,"MEMBER");assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(403);
        assertThat(post(owner,"spaces/"+space+"/invitations/"+invitation+"/revoke",Map.of()).statusCode()).isEqualTo(200);
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(409);
        String expired=inviteId(owner,space,guest.email());jdbc.update("UPDATE auth_space_invitation SET created_at=CURRENT_TIMESTAMP(6)-INTERVAL 9 DAY,expires_at=CURRENT_TIMESTAMP(6)-INTERVAL 1 DAY WHERE id=?",expired);
        assertThat(code(post(guest,"invitations/"+expired+"/accept",Map.of()))).isEqualTo("INVITATION_EXPIRED");
        String disabled=inviteId(owner,space,guest.email());sessions.disableUser(owner.id());assertThat(post(guest,"invitations/"+disabled+"/accept",Map.of()).statusCode()).isEqualTo(403);
    }
    @Test void declineIsIdempotentAndDoesNotAddMembership()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));String invitation=inviteId(owner,space,guest.email());
        assertThat(post(guest,"invitations/"+invitation+"/decline",Map.of()).statusCode()).isEqualTo(200);
        assertThat(post(guest,"invitations/"+invitation+"/decline",Map.of()).statusCode()).isEqualTo(200);
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(409);assertThat(role(space,guest.id())).isNull();
    }
    @Test void mailAndAuditFailuresRollBackInvitationsAndMembershipChanges()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));doThrow(new DataAccessResourceFailureException("private mail detail")).when(mail).enqueue(any());
        assertThat(invite(owner,space,guest.email()).statusCode()).isEqualTo(200);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_space_invitation WHERE space_id=?",Integer.class,space)).isEqualTo(1);
        reset(mail);String invitation=inviteId(owner,space,guest.email());
        doThrow(new DataAccessResourceFailureException("private audit detail")).when(mapper).audit(any());
        assertThat(post(guest,"invitations/"+invitation+"/accept",Map.of()).statusCode()).isEqualTo(503);assertThat(role(space,guest.id())).isNull();
        assertThat(jdbc.queryForObject("SELECT status FROM auth_space_invitation WHERE id=?",String.class,invitation)).isEqualTo("PENDING");
    }
    @Test void roleChangeAndRemovalAuditFailuresNeverApplyUnauditedPermissionChanges()throws Exception{
        String space=team(owner);var member=actor(Set.of("account"));add(space,member,"MEMBER");
        doThrow(new DataAccessResourceFailureException("private audit detail")).when(mapper).audit(any());
        assertThat(changeRole(owner,space,member,"ADMIN").statusCode()).isEqualTo(503);assertThat(role(space,member.id())).isEqualTo("MEMBER");
        assertThat(post(owner,"spaces/"+space+"/members/"+member.id()+"/remove",Map.of()).statusCode()).isEqualTo(503);assertThat(role(space,member.id())).isEqualTo("MEMBER");
    }
    @Test void invitationCannotRacePastADisabledInviter()throws Exception{
        String space=team(owner);var guest=actor(Set.of("account"));String invitation=inviteId(owner,space,guest.email());
        var reached=new CountDownLatch(1);var release=new CountDownLatch(1);var first=new AtomicBoolean(true);
        doAnswer(call->{if(first.getAndSet(false)){reached.countDown();if(!release.await(8,TimeUnit.SECONDS))throw new IllegalStateException("Test release timed out");}
            return sql.getMapper(ai.molis.auth.session.SessionMapper.class).lockUser(owner.id());}).when(sessionMapper).lockUser(owner.id());
        try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
            var response=executor.submit(()->post(guest,"invitations/"+invitation+"/accept",Map.of()));
            try{assertThat(reached.await(5,TimeUnit.SECONDS)).isTrue();sessions.disableUser(owner.id());}finally{release.countDown();}
            assertThat(response.get(12,TimeUnit.SECONDS).statusCode()).isEqualTo(403);assertThat(role(space,guest.id())).isNull();
        }
    }
    @Test void listFilteringAuditAccessAndVersionChecksUseCurrentMembership()throws Exception{
        String space=team(owner);var viewer=actor(Set.of("account"));add(space,viewer,"VIEWER");
        assertThat(data(get(viewer,"spaces?limit=1")).path("items").get(0).path("id").asText()).isEqualTo(space);
        assertThat(get(viewer,"spaces/"+space+"/audit").statusCode()).isEqualTo(403);assertThat(get(viewer,"spaces/"+space+"/invitations").statusCode()).isEqualTo(403);
        assertThat(get(owner,"spaces/"+space+"/audit?limit=1").statusCode()).isEqualTo(200);
        assertThat(put(owner,"spaces/"+space,Map.of("name","Renamed","version",0)).statusCode()).isEqualTo(200);
        assertThat(code(put(owner,"spaces/"+space,Map.of("name","Stale","version",0)))).isEqualTo("VERSION_CONFLICT");
        post(owner,"spaces/"+space+"/members/"+viewer.id()+"/remove",Map.of());assertThat(data(get(viewer,"spaces")).path("items").isEmpty()).isTrue();
    }
    @Test void scopeOriginAndStrictJsonCannotBeUsedToAssertAnOwnerIdentity()throws Exception{
        String space=team(owner);var profile=actor(Set.of("profile"));assertThat(get(profile,"spaces").statusCode()).isEqualTo(403);
        assertThat(send("GET","spaces",owner.tokens().refreshToken(),null,Map.of()).statusCode()).isEqualTo(401);
        var other=actor(Set.of("account"));assertThat(send("GET","spaces",owner.tokens().accessToken(),null,Map.of("Origin",other.origin())).statusCode()).isEqualTo(403);
        assertThat(send("GET","spaces",owner.tokens().accessToken(),null,Map.of("Origin",owner.origin())).statusCode()).isEqualTo(200);
        assertThat(post(owner,"spaces",Map.of("name","Bad","ownerId",other.id())).statusCode()).isEqualTo(400);
        assertThat(get(owner,"spaces?limit=1&limit=2").statusCode()).isEqualTo(400);assertThat(get(owner,"spaces?limit=201").statusCode()).isEqualTo(400);
        var request=HttpRequest.newBuilder(uri("spaces")).header("Authorization","Bearer "+owner.tokens().accessToken()).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("{\"name\":\"a\",\"name\":\"b\"}"));
        assertThat(HTTP.send(request.build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(400);
        assertThat(get(other,"spaces/"+space).statusCode()).isEqualTo(403);assertThat(get(other,"spaces/"+id()).statusCode()).isEqualTo(403);
    }
    @Test void quotaExhaustionAndRedisFailureDoNotCreateInvitationOrMail()throws Exception{
        String space=team(owner);String email=actor(Set.of("account")).email();
        doThrow(new EphemeralFailure(EphemeralFailure.Reason.RATE_LIMITED,55)).when(limiter).acquire(RedisRateLimiter.Bucket.SPACE_INVITE_USER,owner.id());
        var limited=invite(owner,space,email);assertThat(limited.statusCode()).isEqualTo(429);assertThat(limited.headers().firstValue("Retry-After").orElseThrow()).isEqualTo("55");
        doThrow(new EphemeralFailure(EphemeralFailure.Reason.UNAVAILABLE)).when(limiter).acquire(RedisRateLimiter.Bucket.SPACE_INVITE_USER,owner.id());
        assertThat(invite(owner,space,email).statusCode()).isEqualTo(503);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_space_invitation WHERE space_id=?",Integer.class,space)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_mail_outbox WHERE recipient_email=?",Integer.class,email)).isZero();
    }
    @Test void unregisteredRecipientsAreRejectedAndCannotClaimOldInvitations()throws Exception {
        String space=team(owner),email=id()+"@example.test";
        var result=invite(owner,space,email);
        assertThat(result.statusCode()).isEqualTo(400);assertThat(code(result)).isEqualTo("INVITEE_NOT_REGISTERED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM auth_space_invitation WHERE space_id=?",Integer.class,space)).isZero();
    }
    private Actor actor(Set<String> scopes){String user=id(),app=id(),registered=id(),client="spaces-"+id(),email=id()+"@example.test",origin="https://space-"+id()+".example.test";
        jdbc.update("INSERT INTO auth_user(id,display_name,status) VALUES(?,'Preverified fixture','ACTIVE')",user);
        jdbc.update("INSERT INTO auth_user_email(id,user_id,canonical_email,verified_at) VALUES(?,?,?,CURRENT_TIMESTAMP(6))",id(),user,email);
        jdbc.update("INSERT INTO auth_application(id,name,status) VALUES(?,'Space test','ACTIVE')",app);
        jdbc.update("INSERT INTO auth_login_client(id,client_id,application_id,client_type,status,allowed_scopes) VALUES(?,?,?,'WEB','ACTIVE','account profile')",registered,client,app);
        jdbc.update("INSERT INTO auth_login_redirect(client_id,redirect_uri) VALUES(?,?)",registered,origin+"/callback");
        var root=sessions.createAuthentication(user,true);return new Actor(user,email,origin,root,sessions.issueInitial(sessions.createGrant(root.authenticationId(),client,scopes)));}
    private String team(Actor actor)throws Exception{var response=post(actor,"spaces",Map.of("name","Test team"));assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return data(response).path("id").asText();}
    private void add(String space,Actor user,String role){jdbc.update("INSERT INTO auth_membership(space_id,user_id,role) VALUES(?,?,?)",space,user.id(),role);}
    private String role(String space,String user){var values=jdbc.queryForList("SELECT role FROM auth_membership WHERE space_id=? AND user_id=?",String.class,space,user);return values.isEmpty()?null:values.getFirst();}
    private HttpResponse<String> invite(Actor actor,String space,String email)throws Exception{return post(actor,"spaces/"+space+"/invitations",Map.of("email",email,"locale","en"));}
    private String inviteId(Actor actor,String space,String email)throws Exception{var response=invite(actor,space,email);assertThat(response.statusCode()).as(response.body()).isEqualTo(200);return data(response).path("id").asText();}
    private HttpResponse<String> changeRole(Actor actor,String space,Actor target,String role)throws Exception{return put(actor,"spaces/"+space+"/members/"+target.id()+"/role",Map.of("role",role));}
    private HttpResponse<String> get(Actor actor,String path)throws Exception{return send("GET",path,actor.tokens().accessToken(),null,Map.of());}
    private HttpResponse<String> post(Actor actor,String path,Object body)throws Exception{return send("POST",path,actor.tokens().accessToken(),body,Map.of());}
    private HttpResponse<String> put(Actor actor,String path,Object body)throws Exception{return send("PUT",path,actor.tokens().accessToken(),body,Map.of());}
    private HttpResponse<String> send(String method,String path,String token,Object body,Map<String,String> headers)throws Exception{var request=HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(15)).header("Content-Type","application/json");
        if(token!=null)request.header("Authorization","Bearer "+token);headers.forEach(request::header);
        return HTTP.send(request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());}
    private URI uri(String path){return URI.create("http://127.0.0.1:"+port+"/api/v1/"+path);}
    private static JsonNode data(HttpResponse<String> response){return JSON.readTree(response.body()).path("data");}
    private static String code(HttpResponse<String> response){return JSON.readTree(response.body()).path("error").path("code").asText();}
    private static String id(){return UUID.randomUUID().toString();}
    private record Actor(String id,String email,String origin,SessionService.AuthenticationCreated root,SessionService.TokenPair tokens){}
}
