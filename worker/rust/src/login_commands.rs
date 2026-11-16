//! Public login commands; verification state and credential issuance stay in Auth.
use crate::{
    http::*, identity::Auth, registration, security::challenge, sensitive_transactions::shape,
};
use serde_json::{Value, json};
use worker::{Method, Response};

async fn finish(a: &Auth, id: &str) -> Result<Value> {
    let (t, c) = registration::transaction(a, id).await?;
    registration::complete(a, &t, &c).await
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    ensure(method == Method::Post, 405, "METHOD_NOT_ALLOWED")?;
    ensure(
        a.header("Content-Type").split(';').next() == Some("application/json"),
        415,
        "INVALID_REQUEST",
    )?;
    let b: Value = serde_json::from_str(&crate::app::bounded(a, 16384).await?)?;
    let result = if path == "/api/v2/auth/login/code" {
        shape("LoginCodeRequest", &b)?;
        let q =
            a.s.one(
                "SELECT transaction_id FROM auth_verification_challenge WHERE id=?",
                vec![b["verificationId"].clone()],
            )
            .await?;
        ensure(!q.is_null(), 401, "INVALID_CREDENTIALS")?;
        let id = text(&q, "transaction_id");
        let (t, c) = registration::transaction(a, &id).await?;
        ensure(
            t["purpose"] == "LOGIN" && (t["method"] == "EMAIL_CODE" || t["method"] == "PHONE_OTP"),
            400,
            "INVALID_REQUEST",
        )?;
        let proof = registration::verify(
            a,
            &t,
            &c,
            &text(&b, "verificationId"),
            &json!({"credential":b["code"]}),
        )
        .await?;
        let input = json!({"verificationProof":proof["verificationProof"]});
        match registration::identify(a, &t, &c, "code", &input).await {
            // Another verified request may have created the same identity. The failed
            // atomic batch did not consume our proof; retry against its committed owner.
            Err(e) if e.code == "ALREADY_EXISTS" => {
                registration::identify(a, &t, &c, "code", &input).await?;
            }
            other => {
                other?;
            }
        }
        finish(a, &id).await?
    } else {
        let password = path == "/api/v2/auth/login/password";
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
        let created = registration::begin(a, &json!({
            "clientId":b["clientId"],"redirectUri":b["redirectUri"],"state":b["state"],
            "codeChallenge":b["codeChallenge"],"codeChallengeMethod":b["codeChallengeMethod"],
            "initiatorChallenge":b["initiatorChallenge"],"purpose":"LOGIN",
            "method":if password {"ACCOUNT_PASSWORD"} else if b["channel"] == "SMS" {"PHONE_OTP"} else {"EMAIL_CODE"}
        })).await?;
        let id = text(&created, "transactionId");
        let (t, c) = registration::transaction(a, &id).await?;
        if password {
            registration::identify(
                a,
                &t,
                &c,
                "password",
                &json!({"identifier":b["identifier"],"password":b["password"]}),
            )
            .await?;
            finish(a, &id).await?
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
