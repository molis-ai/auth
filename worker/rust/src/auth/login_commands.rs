//! Public login commands; verification state and credential issuance stay in Auth.
use crate::{auth::registration, core::http::*, core::identity::Auth, core::security::challenge};
use serde_json::{Value, json};
use worker::{Method, Response};

pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    ensure(method == Method::Post, 405, "METHOD_NOT_ALLOWED")?;
    ensure(
        a.header("Content-Type").split(';').next() == Some("application/json"),
        415,
        "INVALID_REQUEST",
    )?;
    let b: Value = serde_json::from_str(&bounded(&mut a.request, 16384).await?)?;
    let result = if path == "/api/v1/auth/login/code" {
        shape("LoginCodeRequest", &b)?;
        let verification_id = text(&b, "verificationId");
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
        registration::complete(a, &t, &c).await?
    } else {
        let password = path == "/api/v1/auth/login/password";
        shape(
            if password {
                "LoginPasswordRequest"
            } else {
                "SendLoginVerificationRequest"
            },
            &b,
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
            registration::complete(a, &t, &c).await?
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
    };
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}
