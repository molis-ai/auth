package ai.molis.auth.persistence;

import ai.molis.auth.authorization.SpaceRole;
import java.util.UUID;
import javax.sql.DataSource;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

/**
 * Explicit opt-in, real MySQL only:
 * ./mvnw -Dtest=MySqlSchemaIT -Dauth.it.jdbc-url=jdbc:mysql://127.0.0.1:PORT/auth_test_NAME test
 * Uses a disposable auth_test_* schema, never drops/cleans a database.
 */
class MySqlSchemaIT {
    private static DataSource dataSource;
    private static SqlSessionFactory sessions;
    private static Flyway flyway;

    @BeforeAll
    static void setup() {
        String url = System.getProperty("auth.it.jdbc-url", "");
        if (!url.matches("jdbc:mysql://(127\\.0\\.0\\.1|localhost):[0-9]+/auth_test_[A-Za-z0-9_]+(\\?.*)?")) {
            throw new IllegalArgumentException("Supply a local disposable auth_test_* database via auth.it.jdbc-url");
        }
        dataSource = MySqlTestDataSources.create(url,
                System.getenv().getOrDefault("AUTH_TEST_DB_USER", "root"),
                System.getenv().getOrDefault("AUTH_TEST_DB_PASSWORD", ""));
        flyway = Flyway.configure().dataSource(dataSource).cleanDisabled(true).load();
        flyway.migrate();
        var configuration = new org.apache.ibatis.session.Configuration(
                new Environment("mysql-it", new JdbcTransactionFactory(), dataSource));
        configuration.addMapper(AccountMapper.class);
        sessions = new SqlSessionFactoryBuilder().build(configuration);
    }

    @Test
    void migrationValidatesAndIsRepeatableWithoutReapplying() {
        flyway.validate();
        assertThat(flyway.migrate().migrationsExecuted).isZero();
    }

    @Test
    void createsUserMailboxCredentialPersonalSpaceAndOwnerAtomically() throws Exception {
        String userId = id();
        String spaceId = id();
        String email = id() + "@example.test";
        try (var session = sessions.openSession(false)) {
            var mapper = session.getMapper(AccountMapper.class);
            mapper.insertUser(userId, "测试用户");
            mapper.insertVerifiedEmail(id(), userId, email);
            // Persistence fixture only, not a usable login/password credential.
            mapper.insertLocalCredential(userId, "test-only-unusable-password-hash");
            mapper.insertPersonalSpace(spaceId, userId, "Personal");
            mapper.insertMembership(spaceId, userId, SpaceRole.OWNER);
            session.commit();
        }
        try (var session = sessions.openSession()) {
            assertThat(session.getMapper(AccountMapper.class).findByVerifiedEmail(email))
                    .isEqualTo(new AccountMapper.UserRow(userId, "测试用户", "ACTIVE"));
        }
        assertThat(count("SELECT COUNT(*) FROM auth_membership WHERE space_id = ? AND role = 'OWNER'", spaceId))
                .isEqualTo(1);
    }

    @Test
    void failedAggregateCreationRollsBackAllRows() {
        String existingEmail = id() + "@example.test";
        try (var session = sessions.openSession(false)) {
            var mapper = session.getMapper(AccountMapper.class);
            String existingUser = id();
            mapper.insertUser(existingUser, "Existing");
            mapper.insertVerifiedEmail(id(), existingUser, existingEmail);
            session.commit();
        }
        String candidate = id();
        try (var session = sessions.openSession(false)) {
            var mapper = session.getMapper(AccountMapper.class);
            mapper.insertUser(candidate, "Candidate");
            assertThatThrownBy(() -> mapper.insertVerifiedEmail(id(), candidate, existingEmail))
                    .isInstanceOf(org.apache.ibatis.exceptions.PersistenceException.class);
            session.rollback();
        }
        try (var session = sessions.openSession()) {
            assertThat(session.getMapper(AccountMapper.class).countUser(candidate)).isZero();
        }
    }

    @Test
    void databaseRejectsTwoPersonalSpacesOrTwoOwners() {
        try (var session = sessions.openSession(false)) {
            var mapper = session.getMapper(AccountMapper.class);
            String first = id();
            String second = id();
            String space = id();
            mapper.insertUser(first, "First");
            mapper.insertUser(second, "Second");
            mapper.insertPersonalSpace(space, first, "Personal");
            mapper.insertMembership(space, first, SpaceRole.OWNER);
            assertThatThrownBy(() -> mapper.insertPersonalSpace(id(), first, "Duplicate"))
                    .isInstanceOf(org.apache.ibatis.exceptions.PersistenceException.class);
            assertThatThrownBy(() -> mapper.insertMembership(space, second, SpaceRole.OWNER))
                    .isInstanceOf(org.apache.ibatis.exceptions.PersistenceException.class);
            session.rollback();
        }
    }

    @Test
    void databaseRejectsUnknownRoleAndPersonalArchive() throws Exception {
        try (var session = sessions.openSession(false)) {
            var mapper = session.getMapper(AccountMapper.class);
            String user = id();
            String space = id();
            mapper.insertUser(user, "User");
            mapper.insertPersonalSpace(space, user, "Personal");
            try (var statement = session.getConnection().prepareStatement(
                    "INSERT INTO auth_membership(space_id, user_id, role) VALUES (?, ?, 'CUSTOM')")) {
                statement.setString(1, space);
                statement.setString(2, user);
                assertThatThrownBy(statement::executeUpdate).isInstanceOf(java.sql.SQLException.class);
            }
            try (var statement = session.getConnection().prepareStatement(
                    "UPDATE auth_space SET status = 'ARCHIVED' WHERE id = ?")) {
                statement.setString(1, space);
                assertThatThrownBy(statement::executeUpdate).isInstanceOf(java.sql.SQLException.class);
            }
            session.rollback();
        }
    }

    private static long count(String sql, String value) throws Exception {
        try (var connection = dataSource.getConnection(); var statement = connection.prepareStatement(sql)) {
            statement.setString(1, value);
            try (var result = statement.executeQuery()) {
                result.next();
                return result.getLong(1);
            }
        }
    }

    private static String id() { return UUID.randomUUID().toString(); }
}
