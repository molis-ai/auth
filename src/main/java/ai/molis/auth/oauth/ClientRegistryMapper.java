package ai.molis.auth.oauth;

import java.util.List;
import org.apache.ibatis.annotations.*;

@Mapper
public interface ClientRegistryMapper {
    String COLUMNS = """
            SELECT c.id, c.client_id AS clientId, c.allowed_scopes AS allowedScopes, c.client_type AS clientType
            FROM auth_login_client c JOIN auth_application a ON a.id = c.application_id
            WHERE c.status = 'ACTIVE' AND a.status = 'ACTIVE'
            """;

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(COLUMNS + " AND c.id = #{id}")
    ClientRow findById(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select(COLUMNS + " AND c.client_id = #{clientId}")
    ClientRow findByClientId(String clientId);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("SELECT redirect_uri FROM auth_login_redirect WHERE client_id = #{id}")
    List<String> redirects(String id);

    @Options(useCache = false, flushCache = Options.FlushCachePolicy.TRUE)
    @Select("""
            SELECT r.redirect_uri FROM auth_login_redirect r JOIN auth_login_client c ON c.id = r.client_id
            JOIN auth_application a ON a.id = c.application_id
            WHERE c.status = 'ACTIVE' AND a.status = 'ACTIVE' AND c.client_type = 'WEB'
            """)
    List<String> activeWebRedirects();

    record ClientRow(String id, String clientId, String allowedScopes, String clientType) {}
}
