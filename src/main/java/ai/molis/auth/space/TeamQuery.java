package ai.molis.auth.space;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Set;

/** Name + ID keyset; all values remain bound SQL parameters. */
record TeamQuery(String query, String status, boolean descending, String afterName, String afterId) {
    static TeamQuery parse(String query, String status, String order, String cursor, int limit) {
        query = query == null ? "" : query.strip();
        status = status == null ? "ALL" : status;
        order = order == null ? "asc" : order;
        if (limit < 1 || limit > 200 || query.length() > 120 || query.codePoints().anyMatch(Character::isISOControl)
                || !Set.of("ALL", "ACTIVE", "ARCHIVED").contains(status) || !Set.of("asc", "desc").contains(order)) throw invalid();
        String name = null, id = null;
        if (cursor != null) {
            try {
                if (cursor.length() > 1024) throw invalid();
                String decoded = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
                if (decoded.length() < 38 || decoded.charAt(36) != ':') throw invalid();
                id = decoded.substring(0, 36); name = decoded.substring(37);
                if (!id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") || name.length() > 480) throw invalid();
            } catch (IllegalArgumentException e) { throw invalid(); }
        }
        return new TeamQuery(query, status, order.equals("desc"), name, id);
    }
    static String cursor(SpaceMapper.View team) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString((team.id() + ":" + team.name()).getBytes(StandardCharsets.UTF_8));
    }
    private static SpaceFailure invalid() { return new SpaceFailure(400, "INVALID_REQUEST"); }
}
