package ai.molis.auth.session;

import ai.molis.auth.login.LoginFailure;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import javax.imageio.ImageIO;

/** Accept only bounded raster images; re-encode to discard metadata and trailing payloads. */
public final class ProfileInput {
    private ProfileInput() {}
    public static String name(String value) {
        if (value == null || value.isBlank() || value.codePointCount(0,value.length()) > 120
                || value.codePoints().anyMatch(Character::isISOControl)) throw new LoginFailure(400,"INVALID_DISPLAY_NAME");
        return value.strip();
    }
    public static String avatar(String value) {
        if (value == null) return null;
        if (value.length() > 180000 || !value.startsWith("data:image/png;base64,")) throw new LoginFailure(400,"INVALID_AVATAR");
        try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(value.substring(22))))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) throw new IllegalArgumentException();
            var reader = readers.next();
            try {
                reader.setInput(stream);
                if (!reader.getFormatName().equalsIgnoreCase("png") || reader.getWidth(0) > 256 || reader.getHeight(0) > 256) throw new IllegalArgumentException();
                var image = reader.read(0);
                var output = new ByteArrayOutputStream();
                ImageIO.write(image,"png",output);
                if (output.size() > 135000) throw new IllegalArgumentException();
                return "data:image/png;base64," + Base64.getEncoder().encodeToString(output.toByteArray());
            } finally { reader.dispose(); }
        } catch (Exception error) { throw new LoginFailure(400,"INVALID_AVATAR"); }
    }
}
