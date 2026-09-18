package ai.molis.auth.platform;

import org.apache.ibatis.annotations.*;

@Mapper
public interface ConsoleRegistrationMapper {
    @Select("SELECT application_id,login_client_id FROM auth_console_registration WHERE id='console' FOR UPDATE") Binding lock();
    @Select("SELECT application_id,login_client_id FROM auth_console_registration WHERE id='console'") Binding binding();
    @Update("UPDATE auth_console_registration SET application_id=#{application},login_client_id=#{client} WHERE id='console'")
    int bind(@Param("application") String application,@Param("client") String client);
    record Binding(String applicationId,String loginClientId){}
}
