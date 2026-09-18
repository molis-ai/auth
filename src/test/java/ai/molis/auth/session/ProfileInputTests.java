package ai.molis.auth.session;

import ai.molis.auth.login.LoginFailure;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import javax.imageio.ImageIO;

class ProfileInputTests {
    @Test void validatesNames() {
        assertEquals("庄昊哲", ProfileInput.name(" 庄昊哲 "));
        for (String invalid : new String[]{"", "  ", "bad\nname", "a".repeat(121)})
            assertThrows(LoginFailure.class, () -> ProfileInput.name(invalid));
        assertThrows(LoginFailure.class, () -> ProfileInput.name(null));
    }
    @Test void acceptsOnlyBoundedRasterData() throws Exception {
        assertNull(ProfileInput.avatar(null));
        var output = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(128,128,BufferedImage.TYPE_INT_RGB),"png",output);
        String valid = "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
        assertTrue(ProfileInput.avatar(valid).startsWith("data:image/png;base64,"));
        for (String invalid : new String[]{"https://example.com/avatar.png", "data:image/svg+xml,<svg/>", "data:image/png;base64,bad", "a".repeat(180001)})
            assertThrows(LoginFailure.class, () -> ProfileInput.avatar(invalid));
        output.reset(); ImageIO.write(new BufferedImage(257,1,BufferedImage.TYPE_INT_RGB),"png",output);
        String oversized = "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
        assertThrows(LoginFailure.class, () -> ProfileInput.avatar(oversized));
    }
}
