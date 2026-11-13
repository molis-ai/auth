//! Sole owner of verification-email copy. Templates do not authorize operations or send mail.
const BRAND: &str = "Molis";
const SAFETY_NOTICE: &str = "请勿向他人透露验证码。";
const UNREQUESTED_NOTICE: &str = "如果不是你本人操作，请忽略此邮件，且不要向任何人提供验证码。";

struct Template {
    purpose: &'static str,
    title: &'static str,
    introduction: &'static str,
}
const TEMPLATES: &[Template] = &[
    Template {
        purpose: "EMAIL_SIGNUP",
        title: "注册验证码",
        introduction: "你正在使用此邮箱注册 {brand} 账号。",
    },
    Template {
        purpose: "PASSWORD_RESET",
        title: "密码重置验证码",
        introduction: "你正在重置 {brand} 账号密码。",
    },
    Template {
        purpose: "BIND",
        title: "绑定邮箱验证码",
        introduction: "你正在将此邮箱绑定到 {brand} 账号。",
    },
    Template {
        purpose: "REPLACE",
        title: "更换邮箱验证码",
        introduction: "你正在将 {brand} 账号的绑定邮箱更换为此邮箱。",
    },
    Template {
        purpose: "REAUTH",
        title: "身份验证码",
        introduction: "你正在验证 {brand} 账号身份，以继续进行敏感操作。",
    },
];

pub(crate) struct MailContent {
    pub sender_name: &'static str,
    pub subject: String,
    pub text: String,
}

/// Use the transaction's deadline, never a copy-specific validity period.
/// Unknown purposes, malformed codes and expired challenges must not produce mail.
pub(crate) fn render(purpose: &str, code: &str, expires_at: i64, now: i64) -> Option<MailContent> {
    let template = TEMPLATES.iter().find(|t| t.purpose == purpose)?;
    if code.len() != 6 || !code.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let seconds = expires_at.checked_sub(now)? / 1000;
    if seconds <= 0 {
        return None;
    }
    let duration = format!("{} 分钟", (seconds + 59) / 60);
    Some(MailContent {
        sender_name: BRAND,
        subject: format!("{BRAND} {}", template.title),
        text: format!(
            "{}\n\n验证码：{code}\n\n验证码将在 {duration}后失效。{SAFETY_NOTICE}\n{UNREQUESTED_NOTICE}",
            template.introduction.replace("{brand}", BRAND)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_five_purposes_have_distinct_copy_and_shared_safety_text() {
        let mut subjects = std::collections::HashSet::new();
        for purpose in [
            "EMAIL_SIGNUP",
            "PASSWORD_RESET",
            "BIND",
            "REPLACE",
            "REAUTH",
        ] {
            let mail = render(purpose, "012345", 301_000, 1_000).unwrap();
            assert!(subjects.insert(mail.subject));
            assert_eq!(mail.sender_name, "Molis");
            assert!(mail.text.contains("验证码：012345"));
            assert!(mail.text.contains("5 分钟后失效"));
            assert!(mail.text.contains(SAFETY_NOTICE));
            assert!(mail.text.contains(UNREQUESTED_NOTICE));
            assert!(!mail.text.contains("{brand}"));
        }
    }
    #[test]
    fn validity_is_displayed_in_whole_minutes() {
        assert!(
            render("EMAIL_SIGNUP", "123456", 90_999, 0)
                .unwrap()
                .text
                .contains("2 分钟后失效")
        );
        assert!(
            render("REAUTH", "123456", 59_999, 0)
                .unwrap()
                .text
                .contains("1 分钟后失效")
        );
        assert!(
            render("EMAIL_SIGNUP", "123456", 299_000, 0)
                .unwrap()
                .text
                .contains("5 分钟后失效")
        );
        assert!(render("REAUTH", "123456", 999, 0).is_none());
        assert!(render("REAUTH", "123456", 0, 1).is_none());
    }
    #[test]
    fn invalid_purposes_and_credentials_never_render() {
        assert!(render("OTHER", "123456", 300_000, 0).is_none());
        for code in ["12345", "1234567", "12\n456", "abcdef"] {
            assert!(render("EMAIL_SIGNUP", code, 300_000, 0).is_none());
        }
    }
}
