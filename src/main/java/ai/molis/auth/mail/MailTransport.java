package ai.molis.auth.mail;

public interface MailTransport {
    void send(Message message);
    record Message(String id, String recipient, String subject, String body) {
        @Override public String toString() { return "MailMessage[id=" + id + ", content=[REDACTED]]"; }
    }
    final class DeliveryFailed extends RuntimeException {
        public DeliveryFailed() { super("MAIL_DELIVERY_FAILED"); }
    }
}
