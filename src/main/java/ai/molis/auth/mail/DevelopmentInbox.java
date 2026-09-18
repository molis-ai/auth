package ai.molis.auth.mail;

import java.util.LinkedHashMap;
import java.util.List;

/** Explicit local-development transport, not durable SMTP delivery and never enabled implicitly. */
public final class DevelopmentInbox implements MailTransport {
    private final LinkedHashMap<String, Message> messages = new LinkedHashMap<>();
    @Override public synchronized void send(Message message) {
        messages.put(message.id(), message);
        while (messages.size() > 100) messages.remove(messages.keySet().iterator().next());
    }
    public synchronized List<Message> messages() { return List.copyOf(messages.values()); }
}
