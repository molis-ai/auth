package ai.molis.auth.platform;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class PlatformAdministratorsTests {
    @Test void emptyConfigurationNeverGrantsFirstUserOrSpaceOwner(){
        assertThat(new PlatformAdministrators("").contains(UUID.randomUUID().toString())).isFalse();
        assertThat(new PlatformAdministrators("  ").contains("OWNER")).isFalse();
    }
    @Test void acceptsOnlyExplicitCanonicalUserIds(){String id=UUID.randomUUID().toString();
        var configured=new PlatformAdministrators(" "+id.toUpperCase()+","+id+" ");
        assertThat(configured.contains(id)).isTrue();assertThat(configured.contains(UUID.randomUUID().toString())).isFalse();
    }
    @Test void invalidOrAmbiguousConfigurationFailsClosed(){
        for(String value:new String[]{"*","first-user","OWNER","1-1-1-1-1",UUID.randomUUID()+",",",,"})
            assertThatThrownBy(()->new PlatformAdministrators(value)).isInstanceOf(IllegalArgumentException.class);
    }
}
