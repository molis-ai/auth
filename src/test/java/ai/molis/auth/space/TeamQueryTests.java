package ai.molis.auth.space;

import ai.molis.auth.authorization.SpaceRole;
import java.util.Map;
import org.apache.ibatis.session.Configuration;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class TeamQueryTests {
    @Test void cursorPreservesUnicodeNameAndStableId() {
        var view = new SpaceMapper.View("12345678-1234-1234-1234-123456789012", "团队: A%_", "TEAM", "ACTIVE", 0, SpaceRole.MEMBER, 1, null);
        var filter = TeamQuery.parse(" 团队 ", "ALL", "desc", TeamQuery.cursor(view), 25);
        assertThat(filter.afterName()).isEqualTo(view.name());
        assertThat(filter.afterId()).isEqualTo(view.id());
        assertThat(filter.query()).isEqualTo("团队");
        assertThat(filter.descending()).isTrue();
    }
    @Test void rejectsInvalidParameters() {
        assertThatThrownBy(() -> TeamQuery.parse("", "OWNER", "asc", null, 25)).isInstanceOf(SpaceFailure.class);
        assertThatThrownBy(() -> TeamQuery.parse("", "ALL", "name;DROP", null, 25)).isInstanceOf(SpaceFailure.class);
        assertThatThrownBy(() -> TeamQuery.parse("", "ALL", "asc", "invalid", 25)).isInstanceOf(SpaceFailure.class);
        assertThatThrownBy(() -> TeamQuery.parse("a".repeat(121), "ALL", "asc", null, 25)).isInstanceOf(SpaceFailure.class);
        assertThatThrownBy(() -> TeamQuery.parse("", "ALL", "asc", null, 201)).isInstanceOf(SpaceFailure.class);
    }
    @Test void mapperBindsSearchAndMembershipAndUsesMatchingKeysetOrder() {
        var config = new Configuration(); config.addMapper(SpaceMapper.class);
        var statement = config.getMappedStatement(SpaceMapper.class.getName() + ".teams");
        var view = new SpaceMapper.View("12345678-1234-1234-1234-123456789012", "Same", "TEAM", "ACTIVE", 0, SpaceRole.MEMBER, 1, null);
        for (String order : new String[]{"asc", "desc"}) {
            var sql = statement.getBoundSql(Map.of("user", "user-id", "filter", TeamQuery.parse("%_'", "ARCHIVED", order, TeamQuery.cursor(view), 25), "limit", 26)).getSql().replaceAll("\\s+", " ");
            assertThat(sql).contains("m.user_id=?", "s.space_type='TEAM'", "s.status=?", "LOCATE(?,s.name)", "LIMIT ?").doesNotContain("%_'");
            assertThat(sql).contains(order.equals("asc") ? "s.name > ?" : "s.name < ?");
            assertThat(sql).contains(order.equals("asc") ? "ORDER BY s.name,s.id" : "ORDER BY s.name DESC,s.id DESC");
        }
    }
}
