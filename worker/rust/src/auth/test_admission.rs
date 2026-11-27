use crate::{core::http::*, core::identity::Auth};
use serde_json::Value;

pub(crate) struct Admission(Value);
impl Admission {
    pub(crate) fn load(a: &Auth) -> Result<Self> {
        let list = a
            .env
            .var("AUTH_TEST_ADMISSION")
            .ok()
            .map(|raw| {
                serde_json::from_str::<Value>(&raw.to_string()).map_err(|_| Failure {
                    status: 503,
                    code: "UNIFIED_CONFIGURATION_INVALID",
                })
            })
            .transpose()?
            .unwrap_or(Value::Null);
        let test = a
            .env
            .var("MOLIS_ENVIRONMENT")
            .is_ok_and(|v| v.to_string() == "test");
        if test || !list.is_null() {
            ensure(
                ["emails", "phones"].iter().all(|key| {
                    list[*key]
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string))
                }),
                503,
                "UNIFIED_CONFIGURATION_INVALID",
            )?;
        }
        Ok(Self(list))
    }
    fn contains(&self, field: &str, target: &str) -> bool {
        self.0[field]
            .as_array()
            .is_some_and(|list| list.iter().any(|v| v == target))
    }
    pub(crate) fn target(&self, target: &str) -> Result<()> {
        let field = if target.starts_with('+') {
            "phones"
        } else {
            "emails"
        };
        ensure(
            self.0.is_null() || self.contains(field, target),
            403,
            "FORBIDDEN",
        )
    }
    pub(crate) async fn external(&self, a: &Auth, identity: &Value, user: &Value) -> Result<()> {
        if self.0.is_null() {
            return Ok(());
        }
        // The Google adapter supplies only verified email. GitHub supplies no trusted email.
        if identity["issuer"] == crate::auth::google_login::ISSUER
            && email(&identity["profile"]["email"]).is_ok_and(|v| self.contains("emails", &v))
        {
            return Ok(());
        }
        self.account(a, user).await
    }
    pub(crate) async fn account(&self, a: &Auth, user: &Value) -> Result<()> {
        if self.0.is_null() {
            return Ok(());
        }
        ensure(user.is_string(), 403, "FORBIDDEN")?;
        let contacts = a.s.all(
            "SELECT canonical_email AS address FROM auth_user_email WHERE user_id=? AND verified_at IS NOT NULL
             UNION ALL SELECT canonical_phone FROM auth_user_phone WHERE user_id=? AND verified_at IS NOT NULL",
            vec![user.clone(), user.clone()],
        ).await?;
        ensure(
            contacts.iter().any(|v| {
                v["address"]
                    .as_str()
                    .is_some_and(|address| self.target(address).is_ok())
            }),
            403,
            "FORBIDDEN",
        )
    }
}
