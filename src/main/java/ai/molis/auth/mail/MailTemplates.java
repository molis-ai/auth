package ai.molis.auth.mail;

import java.net.URI;

/** Plain-text bilingual templates; never accept caller-controlled URLs, HTML, subjects or headers. */
public final class MailTemplates {
    private final MailPayloadCipher cipher;
    private final String origin;
    public MailTemplates(MailPayloadCipher cipher, String authOrigin) {
        URI uri = URI.create(authOrigin);
        boolean local = "localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "[::1]".equals(uri.getHost());
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))
                || !("https".equals(uri.getScheme()) || (local && "http".equals(uri.getScheme()))))
            throw new IllegalArgumentException("Mail links require an HTTPS Auth origin (loopback development excepted)");
        this.cipher = cipher; this.origin = authOrigin.endsWith("/") ? authOrigin.substring(0, authOrigin.length() - 1) : authOrigin;
    }
    public MailTransport.Message render(MailOutboxMapper.Row row) {
        boolean en = "en".equals(row.locale());
        String subject, body;
        switch (row.template()) {
            case "SPACE_INVITED" -> {
                if(row.expiresAt()==null)throw new IllegalArgumentException("Invitation mail requires expiry");
                subject=en?"You have a team space invitation":"你收到了团队空间邀请";
                body=(en?"Sign in with this verified email address to review your pending invitations. Joining requires your explicit acceptance; opening this link does not join a space. The invitation expires within 7 days.\n\n"
                        :"请使用此已验证邮箱登录，在待处理邀请中查看详情并明确同意。打开链接不会自动加入空间。邀请将在 7 天内到期。\n\n")+origin+"/console";
            }
            case "ACCOUNT_REGISTERED" -> {
                subject = en ? "Your account is ready" : "账号已创建";
                body = en ? "Your account and personal space have been created. You can sign in to continue."
                        : "你的账号和个人空间已创建，可以登录后继续使用。";
            }
            case "PASSWORD_CHANGED" -> {
                subject = en ? "Your password was changed" : "密码已重置";
                body = en ? "Your password was changed and previous sessions were signed out. If this was not you, use password recovery immediately."
                        : "你的密码已重置，原有登录会话已退出。如非本人操作，请立即使用找回密码功能。";
            }
            case "VERIFY_REGISTER", "VERIFY_PASSWORD_RESET", "VERIFY_EXTERNAL_IDENTITY" -> {
                if (row.expiresAt() == null) throw new IllegalArgumentException("Verification mail requires expiry");
                String[] proof = cipher.open(row.payload(), row.context()).split("\\n", -1);
                if (proof.length != 2 || !proof[0].matches("[A-Za-z0-9_-]{43}") || !proof[1].matches("[A-Za-z0-9_-]{43}"))
                    throw new IllegalArgumentException("Invalid verification mail payload");
                String link = origin + "/verify-email#challenge=" + proof[0] + "&token=" + proof[1];
                boolean register = row.template().equals("VERIFY_REGISTER");
                subject = en ? (register ? "Verify your email to create an account" : "Verify your password reset request")
                        : (register ? "验证邮箱并创建账号" : "验证密码重置请求");
                if (row.template().equals("VERIFY_EXTERNAL_IDENTITY"))
                    subject = en ? "Verify your email for external sign-in" : "验证第三方登录使用的邮箱";
                body = (en ? "Open the link and confirm only if you requested this action. The link expires within 10 minutes.\n\n"
                        : "请打开链接，仅在你本人发起此请求时确认。链接将在 10 分钟内失效。\n\n") + link
                        + (en ? "\n\nIf you did not request this, ignore this email. Do not forward the link."
                        : "\n\n如非本人操作，请忽略此邮件。请勿转发链接。");
                if (row.template().equals("VERIFY_EXTERNAL_IDENTITY"))
                    body += en ? "\n\nThis verifies only your mailbox. Return to the original sign-in page to continue. It does not reset a password or merge existing accounts."
                            : "\n\n此操作只验证邮箱归属。请返回原登录页面继续，不会重置密码或合并已有账号。";
            }
            default -> throw new IllegalArgumentException("Unknown mail template");
        }
        return new MailTransport.Message(row.id(), row.recipient(), subject, body);
    }
}
