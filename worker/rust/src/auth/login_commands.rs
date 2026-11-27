//! Public login commands; verification state and credential issuance stay in Auth.
use crate::{
    auth::{login_sessions, registration},
    core::http::*,
    core::identity::Auth,
    core::security::challenge,
};
use serde_json::{Value, json};
use worker::Method;

#[derive(Clone, Copy)]
pub(crate) enum Completion {
    Code,
    Session,
}

impl Completion {
    async fn finish(self, a: &Auth, t: &Value, c: &Value) -> Result<Value> {
        match self {
            Self::Code => registration::complete(a, t, c).await,
            Self::Session => login_sessions::issue_browser_login(a, t, c).await,
        }
    }
}

pub async fn route(a: &Auth, path: &str, method: Method, body: Value) -> Result<Value> {
    ensure(method == Method::Post, 405, "METHOD_NOT_ALLOWED")?;
    execute(a, path, &body, Completion::Code).await
}

pub(crate) async fn browser_password(
    a: &Auth,
    client_id: &str,
    body: &Value,
    prepare: impl AsyncFnOnce(&Value) -> Result<Vec<worker::D1PreparedStatement>>,
) -> Result<Value> {
    use crate::account::management::{USER_VIEW, platform_capabilities, user_view_value};
    use login_sessions as sessions;

    shape("ProductLoginPasswordRequest", body)?;
    let identity = registration::PasswordIdentity::new(a, &body["identifier"], true)?;
    let subject = identity.subject("?1");
    let [clients, candidates, users, capabilities] = a.s.batch_read(vec![
        sessions::registered_client_statement(a, client_id)?,
        identity.lookup(a)?,
        a.s.statement(&format!("{USER_VIEW}{subject}"), vec![identity.address.clone().into()])?,
        a.s.statement(&format!(
            "SELECT permission FROM auth_platform_permission WHERE user_id={subject} AND status='ACTIVE' ORDER BY permission"
        ), vec![identity.address.clone().into()])?,
    ]).await?.try_into().map_err(|_| Failure::unavailable())?;
    let c = clients.into_iter().next().unwrap_or(Value::Null);
    sessions::validate_registered_client(a, &c)?;
    sessions::check_origin(&c, &a.origin)?;
    ensure(
        contains(
            &parsed(&c, "redirects")?,
            &json!(format!("{}/account/callback", a.origin)),
        ),
        400,
        "INVALID_REQUEST",
    )?;

    a.rate_batch(&[
        ("auth:begin", &a.client_ip, 60, 60_000),
        ("auth:password", &a.client_ip, 30, 60_000),
        ("auth:password-target", &identity.address, 10, 300_000),
    ])
    .await?;
    let candidate = candidates.into_iter().next().unwrap_or(Value::Null);
    let password_guard = identity
        .verify(a, &candidate, &text(body, "password"))
        .await?;
    let n = now();
    let mut writes = vec![
        sessions::client_guard(a, &c)?,
        password_guard,
        a.s.statement(
            "INSERT INTO auth_security_sequence(kind,created_at) VALUES ('LOGIN',?)",
            vec![n.into()],
        )?,
    ];
    let user_id = text(&candidate, "id");
    let tokens = sessions::create_login(
        a,
        &c,
        &json!({"user_id":user_id,"user_epoch":candidate["session_epoch"]}),
        n,
        &mut writes,
    )?;
    writes.extend(prepare(&tokens).await?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    let user = user_view_value(
        a,
        &user_id,
        &users.into_iter().next().ok_or_else(Failure::unavailable)?,
    );
    Ok(
        json!({"account":{"state":"AUTHENTICATED","user":user,"session":tokens["session"],
                         "capabilities":platform_capabilities(capabilities)}}),
    )
}

pub(crate) async fn browser_code(
    a: &Auth,
    client_id: &str,
    body: &Value,
    initiator: &str,
    prepare: impl AsyncFnOnce(&Value) -> Result<Vec<worker::D1PreparedStatement>>,
) -> Result<Value> {
    use crate::account::management::{USER_VIEW, platform_capabilities, user_view_value};
    use crate::core::security::uuid;
    use login_sessions as sessions;

    let id = text(body, "verificationId");
    let subject = "(SELECT CASE q.channel WHEN 'EMAIL' THEN
            (SELECT e.user_id FROM auth_user_email e WHERE e.canonical_email=q.canonical_target)
          ELSE (SELECT p.user_id FROM auth_user_phone p WHERE p.canonical_phone=q.canonical_target) END
          FROM auth_verification_challenge q WHERE q.id=?1)";
    let query = |sql: &str| a.s.statement(sql, vec![id.clone().into()]);
    let [
        clients,
        transactions,
        challenges,
        identities,
        users,
        capabilities,
    ] =
        a.s.batch_read(vec![
            sessions::registered_client_statement(a, client_id)?,
            query(
                "SELECT t.* FROM auth_product_transaction t JOIN auth_verification_challenge q
               ON q.transaction_id=t.id WHERE q.id=?1",
            )?,
            query("SELECT * FROM auth_verification_challenge WHERE id=?1")?,
            query(&format!(
                "SELECT id,status,session_epoch FROM auth_user WHERE id={subject}"
            ))?,
            query(&format!("{USER_VIEW}{subject}"))?,
            query(&format!(
                "SELECT permission FROM auth_platform_permission WHERE user_id={subject}
                        AND status='ACTIVE' ORDER BY permission"
            ))?,
        ])
        .await?
        .try_into()
        .map_err(|_| Failure::unavailable())?;
    let first = |rows: Vec<Value>| rows.into_iter().next().unwrap_or(Value::Null);
    let c = first(clients);
    let t = first(transactions);
    let q = first(challenges);
    sessions::validate_registered_client(a, &c)?;
    ensure(
        token(initiator)
            && t["initiator_hash"] == challenge(initiator)
            && t["client_id"] == c["client_id"]
            && t["environment_id"] == c["environment_id"],
        401,
        "INVALID_CREDENTIALS",
    )?;
    let email = t["method"] == "EMAIL_CODE";
    ensure(
        t["purpose"] == "LOGIN"
            && (email && q["channel"] == "EMAIL"
                || t["method"] == "PHONE_OTP" && q["channel"] == "SMS")
            && contains(&parsed(&c, "redirects")?, &t["redirect_uri"]),
        400,
        "INVALID_REQUEST",
    )?;
    a.rate_ip("auth:verify", 120).await?;
    registration::authenticate_challenge(a, &t, &c, &q, &id, &text(body, "code")).await?;

    let n = now();
    let existing = first(identities);
    let target = text(&q, "canonical_target");
    let (table, column) = if email {
        ("auth_user_email", "canonical_email")
    } else {
        ("auth_user_phone", "canonical_phone")
    };
    let mut writes = vec![
        sessions::client_guard(a, &c)?,
        registration::tx_guard(a, &t, n, "PENDING")?,
        a.s.guard(
            "EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND transaction_id=?
            AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>?)",
            vec![id.clone().into(), t["id"].clone(), n.into()],
        )?,
        a.s.statement(
            "UPDATE auth_verification_challenge SET consumed_at=? WHERE id=?",
            vec![n.into(), id.into()],
        )?,
    ];
    let (user_id, epoch, user) = if existing.is_null() {
        let user = uuid();
        writes.extend(registration::new_user(a, &user, n)?);
        writes.push(a.s.statement(
            &format!("INSERT INTO {table} VALUES (?,?,?,?,?)"),
            vec![
                uuid().into(),
                user.clone().into(),
                target.clone().into(),
                n.into(),
                n.into(),
            ],
        )?);
        let view = json!({"display_name":"Molis 用户","account_version":0,"email":if email { json!(target) } else { Value::Null }});
        (user, 0, view)
    } else {
        ensure(existing["status"] == "ACTIVE", 401, "INVALID_CREDENTIALS")?;
        writes.push(a.s.guard(
            &format!("EXISTS(SELECT 1 FROM {table} WHERE user_id=? AND {column}=? AND verified_at IS NOT NULL)"),
            vec![existing["id"].clone(), target.into()],
        )?);
        (
            text(&existing, "id"),
            number(&existing, "session_epoch"),
            first(users),
        )
    };
    writes.push(registration::boundary(a, &t, &user_id, epoch)?);
    writes.push(a.s.statement(
        "UPDATE auth_product_transaction SET status='CONSUMED',user_id=?,user_epoch=?,completed_at=? WHERE id=?",
        vec![user_id.clone().into(),epoch.into(),n.into(),t["id"].clone()],
    )?);
    writes.push(crate::audit::account(
        a,
        "account.verify",
        user_id.clone().into(),
        &c["client_id"],
        Value::Null,
    )?);
    let tokens = sessions::create_login(
        a,
        &c,
        &json!({
            "user_id":user_id,"user_epoch":epoch,"created_seq":t["created_seq"],
        }),
        n,
        &mut writes,
    )?;
    writes.extend(prepare(&tokens).await?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(
        json!({"account":{"state":"AUTHENTICATED","user":user_view_value(a,&user_id,&user),
        "session":tokens["session"],"capabilities":platform_capabilities(capabilities)}}),
    )
}

pub(crate) async fn execute(
    a: &Auth,
    path: &str,
    b: &Value,
    completion: Completion,
) -> Result<Value> {
    Ok(if path == "/api/v1/auth/login/code" {
        shape("LoginCodeRequest", b)?;
        let verification_id = text(b, "verificationId");
        let (mut t, c) = registration::challenge_transaction(a, &verification_id).await?;
        ensure(
            t["purpose"] == "LOGIN" && (t["method"] == "EMAIL_CODE" || t["method"] == "PHONE_OTP"),
            400,
            "INVALID_REQUEST",
        )?;
        let proof = registration::verify(
            a,
            &t,
            &c,
            &verification_id,
            &json!({"credential":b["code"]}),
        )
        .await?;
        let input = json!({"verificationProof":proof["verificationProof"]});
        registration::identify(a, &mut t, &c, "code", &input).await?;
        completion.finish(a, &t, &c).await?
    } else {
        let password = path == "/api/v1/auth/login/password";
        shape(
            if password {
                "LoginPasswordRequest"
            } else {
                "SendLoginVerificationRequest"
            },
            b,
        )?;
        let proof = a.header("X-Auth-Initiator-Proof");
        ensure(
            token(&proof) && b["initiatorChallenge"] == challenge(&proof),
            401,
            "INVALID_CREDENTIALS",
        )?;
        let (mut t, c) = registration::begin_login(a, &json!({
            "clientId":b["clientId"],"redirectUri":b["redirectUri"],"state":b["state"],
            "codeChallenge":b["codeChallenge"],"codeChallengeMethod":b["codeChallengeMethod"],
            "initiatorChallenge":b["initiatorChallenge"],"purpose":"LOGIN",
            "method":if password {"ACCOUNT_PASSWORD"} else if b["channel"] == "SMS" {"PHONE_OTP"} else {"EMAIL_CODE"}
        })).await?;
        if password {
            registration::identify(
                a,
                &mut t,
                &c,
                "password",
                &json!({"identifier":b["identifier"],"password":b["password"]}),
            )
            .await?;
            completion.finish(a, &t, &c).await?
        } else {
            let sent = registration::send(
                a,
                &t,
                &c,
                &json!({"channel":b["channel"],"address":b["address"]}),
            )
            .await?;
            json!({"verificationId":sent["challengeId"],"expiresAt":sent["expiresAt"],"retryAfterSeconds":sent["retryAfterSeconds"]})
        }
    })
}
