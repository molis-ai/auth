package ai.molis.auth.platform;

import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Deployment-only whitelist. No database role, first-user shortcut, or API for granting platform access. */
@Component
public final class PlatformAdministrators {
    private final Set<String> userIds;
    public PlatformAdministrators(@Value("${auth.platform.admin-user-ids:}") String configured){
        if(configured==null||configured.isBlank()){userIds=Set.of();return;}
        var values=new HashSet<String>();
        for(String item:configured.split(",",-1)){
            String value=item.strip();
            if(!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
                throw new IllegalArgumentException("Platform administrator configuration requires UUID user IDs");
            values.add(UUID.fromString(value).toString());
        }
        userIds=Set.copyOf(values);
    }
    public boolean contains(String verifiedUserId){return userIds.contains(verifiedUserId);}
}
