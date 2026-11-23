//! Display metadata from verified provider assertions; never a login/email binding.
use crate::{http::*, identity::Auth};
use serde_json::Value;
use worker::D1PreparedStatement;

pub(crate) fn save(a: &Auth, identity: &Value, user: &str) -> Result<Vec<D1PreparedStatement>> {
    let Some(profile) = identity.get("profile") else {
        return Ok(vec![]);
    };
    Ok(vec![
        a.s.statement("INSERT INTO auth_external_profile(issuer,subject,display_name,email,avatar_url,username) VALUES (?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,avatar_url=excluded.avatar_url,username=excluded.username", vec![identity["issuer"].clone(),identity["subject"].clone(),profile["name"].clone(),profile["email"].clone(),profile["avatar"].clone(),profile["username"].clone()])?,
        // Fill missing defaults only. Explicit profile changes/removals remain authoritative.
        a.s.statement("UPDATE auth_user SET display_name=CASE WHEN display_name='Molis 用户' AND NOT EXISTS(SELECT 1 FROM auth_profile_customization WHERE user_id=? AND name_customized=1) THEN COALESCE(?,display_name) ELSE display_name END, avatar_data=CASE WHEN avatar_data IS NULL AND NOT EXISTS(SELECT 1 FROM auth_profile_customization WHERE user_id=? AND avatar_customized=1) THEN ? ELSE avatar_data END WHERE id=?",vec![user.into(),profile["name"].clone(),user.into(),profile["avatar"].clone(),user.into()])?,
    ])
}
