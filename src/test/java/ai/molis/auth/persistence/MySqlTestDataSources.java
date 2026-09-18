package ai.molis.auth.persistence;

import java.util.Properties;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Same instant-preserving JDBC policy as the application's Hikari datasource. */
public final class MySqlTestDataSources {
    private MySqlTestDataSources() {}
    public static DriverManagerDataSource create(String url, String user, String password) {
        var source = new DriverManagerDataSource(url, user, password);
        var properties = new Properties();
        properties.setProperty("connectionTimeZone", "UTC");
        properties.setProperty("forceConnectionTimeZoneToSession", "true");
        properties.setProperty("preserveInstants", "true");
        source.setConnectionProperties(properties);
        return source;
    }
}
