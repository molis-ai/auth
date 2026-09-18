package ai.molis.auth.account;

import java.util.Locale;

/** V1 conventional ASCII mailboxes, case-insensitive account identifiers; no provider alias merging. */
public final class EmailAddress {
    private EmailAddress() {}
    public static String canonicalize(String input) {
        if (input == null) throw new IllegalArgumentException("INVALID_EMAIL");
        String value = input.strip().toLowerCase(Locale.ROOT);
        if (value.length() > 254 || !value.matches("[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
                || value.indexOf('@') > 64) throw new IllegalArgumentException("INVALID_EMAIL");
        for (String label : value.substring(value.indexOf('@') + 1).split("\\."))
            if (label.length() > 63) throw new IllegalArgumentException("INVALID_EMAIL");
        return value;
    }
}
