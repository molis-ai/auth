package ai.molis.example.auth;

import java.util.List;
import org.apache.ibatis.annotations.*;

/** Business-owned records. No joins or foreign keys into Auth's database. */
@Mapper
public interface ProjectMapper {
    @Select("SELECT id,space_id,name,state,version FROM demo_project WHERE id=#{id}") Project find(String id);
    @Select("SELECT id,space_id,name,state,version FROM demo_project WHERE id=#{id} FOR UPDATE") Project lock(String id);
    String SCOPE="""
        <choose><when test="spaces.size > 0">space_id IN <foreach collection="spaces" item="space" open="(" close=")" separator=",">#{space}</foreach></when><otherwise>1=0</otherwise></choose>
        """;
    @Select("<script>SELECT id,space_id,name,state,version FROM demo_project WHERE "+SCOPE+" AND id &gt; #{cursor} ORDER BY id LIMIT #{limit}</script>")
    List<Project> page(@Param("spaces") List<String> spaces,@Param("cursor") String cursor,@Param("limit") int limit);
    @Select("<script>SELECT COUNT(*) FROM demo_project WHERE "+SCOPE+"</script>") long count(@Param("spaces") List<String> spaces);
    @Update("UPDATE demo_project SET name=#{name},version=version+1 WHERE id=#{id} AND version=#{version} AND state='EDITABLE'")
    int rename(@Param("id") String id,@Param("name") String name,@Param("version") long version);
    record Project(String id,String spaceId,String name,String state,long version){}
}
