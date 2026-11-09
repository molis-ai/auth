//! Product authentication orchestration. Central proofs remain in the encrypted BFF session.
use crate::{
    http::*,
    security::{challenge, secret},
    sensitive_transactions::shape,
    web_session::WebSession,
};
use serde_json::{Value, json};
use worker::Method;
fn view(t: &Value) -> Value {
    json!({"handle":t["id"],"status":t["status"],"nextStep":t["nextStep"],"expiresAt":t["expiresAt"]})
}
async fn call(
    s: &WebSession<'_>,
    t: &Value,
    suffix: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value> {
    ensure(
        !matches!(text(t, "status").as_str(), "CANCELLED" | "EXPIRED"),
        409,
        "TRANSACTION_EXPIRED",
    )?;
    let expiry = t["expiresAt"]
        .as_str()
        .map(js_sys::Date::parse)
        .unwrap_or(0.0);
    ensure(expiry > now() as f64, 409, "TRANSACTION_EXPIRED")?;
    s.call(
        &format!("/api/v2/auth/transactions/{}{suffix}", text(t, "id")),
        method,
        body,
        Some(&text(t, "proof")),
        None,
    )
    .await
}
async fn sync(s: &WebSession<'_>, t: &mut Value) -> Result<Value> {
    let reply = call(s, t, "", Method::Get, None).await?;
    t["status"] = reply["status"].clone();
    t["nextStep"] = reply["nextStep"].clone();
    Ok(view(t))
}
async fn send(s: &WebSession<'_>, t: &mut Value) -> Result<Value> {
    ensure(
        !t["address"].is_null() && t["verification"].is_null(),
        400,
        "INVALID_REQUEST",
    )?;
    let reply=call(s,t,"/challenges",Method::Post,Some(json!({"channel":if t["method"]=="PHONE_OTP"{"SMS"}else{"EMAIL"},"address":t["address"]}))).await?;
    t["challenge"] = reply["challengeId"].clone();
    t["nextStep"] = "VERIFY_CHALLENGE".into();
    Ok(
        json!({"challengeHandle":t["challenge"],"nextStep":"VERIFY_CHALLENGE","expiresAt":reply["expiresAt"],"retryAfterSeconds":reply["retryAfterSeconds"]}),
    )
}
pub async fn route(
    s: &mut WebSession<'_>,
    path: &str,
    method: Method,
    b: &mut Value,
) -> Result<Value> {
    if path == "/account/callback" {
        ensure(method == Method::Get, 400, "INVALID_REQUEST")?;
        let url = s.a.request.url()?;
        let query = form(url.query().unwrap_or_default())?;
        shape("ProductCallbackQuery", &query)?;
        let id = text(&query, "transactionId");
        let mut t = s.data["transactions"][&id].take();
        let result = async {
            ensure(
                t.is_object()
                    && query["state"] == t["state"]
                    && matches!(t["method"].as_str(), Some("GOOGLE" | "GITHUB"))
                    && t["nextStep"] == "WAIT_PROVIDER",
                403,
                "FORBIDDEN",
            )?;
            let actual = sync(s, &mut t).await?;
            ensure(
                (query["result"] == "VERIFIED" && actual["status"] == "VERIFIED")
                    || ((query["result"] == "CANCELLED" || query["result"] == "FAILED")
                        && actual["status"] == "CANCELLED"),
                403,
                "FORBIDDEN",
            )?;
            Ok(json!({"status":actual["status"]}))
        }
        .await;
        s.data["transactions"][id] = t;
        return result;
    }
    if path == "/api/account/password/change" || path.starts_with("/api/account/login-methods/") {
        return mutate(s, path, method, b).await;
    }
    let create = path == "/api/account/auth/transactions" && method == Method::Post;
    let reauth = path == "/api/account/reauthentications" && method == Method::Post;
    if create || reauth {
        shape(
            if reauth {
                "ProductReauthenticationRequest"
            } else {
                "ProductTransactionRequest"
            },
            b,
        )?;
        let purpose = if reauth {
            "REAUTH".to_string()
        } else {
            text(b, "purpose")
        };
        let protected = matches!(purpose.as_str(), "REAUTH" | "BIND" | "REPLACE");
        if protected {
            s.fresh().await?;
        } else {
            ensure(s.data["tokens"].is_null(), 409, "VERSION_CONFLICT")?;
            s.data["transactions"] = json!({});
        }
        let mut t = json!({"method":b["method"],"purpose":purpose,"proof":secret(),"verifier":secret(),"state":secret(),"status":"PENDING"});
        let mut input = json!({"clientId":s.client()?,"redirectUri":format!("{}/account/callback",s.a.origin),"purpose":purpose,"method":b["method"],"state":t["state"],"codeChallenge":challenge(&text(&t,"verifier")),"codeChallengeMethod":"S256","initiatorChallenge":challenge(&text(&t,"proof"))});
        if reauth {
            input.as_object_mut().expect("request").remove("purpose");
            input["operation"] = b["operation"].clone();
            input["target"] = b["target"].clone();
            t["operation"] = b["operation"].clone();
            t["target"] = b["target"].clone();
        }
        if purpose == "BIND" || purpose == "REPLACE" {
            let parent = &s.data["transactions"][text(b, "reauthHandle")];
            ensure(
                parent["purpose"] == "REAUTH" && !parent["operationProof"].is_null(),
                403,
                "FORBIDDEN",
            )?;
            let operation = if purpose == "BIND" {
                "BIND_METHOD"
            } else {
                "REPLACE_METHOD"
            };
            ensure(parent["operation"] == operation, 403, "FORBIDDEN")?;
            let target = if purpose == "BIND" {
                let kind = match text(b, "method").as_str() {
                    "EMAIL_CODE" => "EMAIL".into(),
                    "PHONE_OTP" => "PHONE".into(),
                    v => v.to_owned(),
                };
                json!({"method":kind})
            } else {
                json!({"bindingId":b["bindingId"]})
            };
            ensure(target == parent["target"], 403, "FORBIDDEN")?;
            if purpose == "REPLACE" {
                input["bindingId"] = b["bindingId"].clone();
            }
            t["parent"] = b["reauthHandle"].clone();
        }
        let expired: Vec<String> = s.data["transactions"]
            .as_object()
            .map(|items| {
                items
                    .iter()
                    .filter(|(_, t)| {
                        matches!(t["status"].as_str(), Some("CANCELLED" | "EXPIRED"))
                            || t["expiresAt"]
                                .as_str()
                                .map(js_sys::Date::parse)
                                .unwrap_or(0.0)
                                <= now() as f64
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in expired {
            s.data["transactions"]
                .as_object_mut()
                .expect("transactions")
                .remove(&id);
        }
        ensure(
            s.data["transactions"].as_object().map_or(0, |v| v.len()) < 32,
            409,
            "VERSION_CONFLICT",
        )?;
        let reply = s
            .call(
                if reauth {
                    "/api/v2/users/me/reauthentications"
                } else {
                    "/api/v2/auth/transactions"
                },
                Method::Post,
                Some(input),
                None,
                None,
            )
            .await?;
        t["id"] = reply["transactionId"].clone();
        t["nextStep"] = reply["nextStep"].clone();
        t["expiresAt"] = reply["expiresAt"].clone();
        let id = text(&t, "id");
        let result = view(&t);
        s.data["transactions"][id] = t;
        return Ok(result);
    }
    if path == "/api/account/password/reset" {
        shape("ProductPasswordResetRequest", b)?;
        let id = text(b, "resetHandle");
        let mut t = s.data["transactions"][&id].take();
        ensure(
            t["purpose"] == "PASSWORD_RESET" && !t["resetProof"].is_null(),
            403,
            "FORBIDDEN",
        )?;
        let proof = t["resetProof"].take();
        return s
            .call(
                "/api/v2/auth/password-reset/complete",
                Method::Post,
                Some(json!({"transactionId":id,"resetProof":proof,"newPassword":b["newPassword"]})),
                Some(&text(&t, "proof")),
                None,
            )
            .await;
    }
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    ensure(
        parts.len() >= 5 && parts[..4] == ["api", "account", "auth", "transactions"],
        404,
        "NOT_FOUND",
    )?;
    let id = parts[4];
    let mut t = s.data["transactions"][id].take();
    ensure(t.is_object(), 404, "NOT_FOUND")?;
    let result=async {
  if parts.len()==5&&method==Method::Get {
   if matches!(t["method"].as_str(),Some("GOOGLE"|"GITHUB")){
     if t["nextStep"]=="WAIT_PROVIDER"{sync(s,&mut t).await?;}
     if t["status"]=="VERIFIED"{return finish(s,&mut t).await;}
     if t["status"]=="CONSUMED"{
       if t["purpose"]=="LOGIN"{return Ok(json!({"account":s.view().await?}));}
       return Ok(json!({"operationReady":!t["operationProof"].is_null()||!t["newIdentityProof"].is_null()}));
     }
   }
   return Ok(view(&t));
  }
  ensure(method==Method::Post&&parts.len()==6,404,"NOT_FOUND")?;
  if parts[5]=="cancel" {shape("Empty",b)?;t["status"]="CANCELLED".into();t["operationProof"]=Value::Null;t["newIdentityProof"]=Value::Null;t["resetProof"]=Value::Null;return Ok(view(&t));}
  if parts[5]=="resend" {shape("Empty",b)?;return send(s,&mut t).await;}
  ensure(parts[5]=="submit",404,"NOT_FOUND")?;shape("ProductSubmitRequest",b)?;
  let step=text(b,"step");ensure(t["nextStep"]==step,400,"INVALID_REQUEST")?;
  match step.as_str(){
   "REQUEST_CHALLENGE"=>{t["address"]=b["address"].clone();return send(s,&mut t).await;},
   "VERIFY_CHALLENGE"=>{ensure(b["challengeHandle"]==t["challenge"],403,"FORBIDDEN")?;let result=call(s,&t,&format!("/challenges/{}/verify",text(&t,"challenge")),Method::Post,Some(json!({"credential":b["credential"]}))).await?;t["verification"]=result["verificationProof"].clone();},
   "PASSWORD_LOGIN"=>{call(s,&t,"/password",Method::Post,Some(json!({"email":b["email"],"password":b["password"]}))).await?;},
   "EMAIL_SIGNUP"=>{ensure(text(b,"email").trim().to_lowercase()==text(&t,"address").trim().to_lowercase(),403,"FORBIDDEN")?;call(s,&t,"/email-signup",Method::Post,Some(json!({"email":b["email"],"password":b["password"],"verificationProof":t["verification"]}))).await?;t["verification"]=Value::Null;},
   "PHONE_LOGIN"=>{call(s,&t,"/phone",Method::Post,Some(json!({"verificationProof":t["verification"]}))).await?;t["verification"]=Value::Null;},
   "START_PROVIDER"=>{let provider=text(&t,"method").to_lowercase();ensure(["google","github"].contains(&provider.as_str()),400,"INVALID_REQUEST")?;let result=call(s,&t,&format!("/providers/{provider}/start"),Method::Post,Some(json!({}))).await?;t["nextStep"]="WAIT_PROVIDER".into();return Ok(result);},
   "COMPLETE"=>return finish(s,&mut t).await,
   _=>return Err(Failure{status:400,code:"INVALID_REQUEST"}),
  }
  sync(s,&mut t).await
 }.await;
    s.data["transactions"][id] = t;
    result
}
async fn finish(s: &mut WebSession<'_>, t: &mut Value) -> Result<Value> {
    let result = call(s, t, "/complete", Method::Post, Some(json!({}))).await?;
    t["status"] = "CONSUMED".into();
    t["nextStep"] = "NONE".into();
    if result["kind"] == "LOGIN_CODE" {
        ensure(result["state"] == t["state"], 403, "FORBIDDEN")?;
        let tokens=s.call("/api/v2/auth/token",Method::Post,Some(json!({"grantType":"authorization_code","clientId":s.client()?,"redirectUri":format!("{}/account/callback",s.a.origin),"code":result["code"],"codeVerifier":t["verifier"]})),None,None).await?;
        shape("TokenSet", &tokens)?;
        s.data["tokens"] = tokens;
        return Ok(json!({"account":s.view().await?,"status":"CONSUMED"}));
    }
    for field in ["operationProof", "newIdentityProof", "resetProof"] {
        if !result[field].is_null() {
            t[field] = result[field].clone();
        }
    }
    t["expiresAt"] = result["expiresAt"].clone();
    Ok(json!({"operationReady":true}))
}

async fn mutate(s: &mut WebSession<'_>, path: &str, method: Method, b: &Value) -> Result<Value> {
    ensure(method == Method::Post, 404, "NOT_FOUND")?;
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let (operation, schema, target) = if path == "/api/account/password/change" {
        (
            "CHANGE_PASSWORD",
            "ProductPasswordChangeRequest",
            "/api/v2/users/me/password/change".to_owned(),
        )
    } else if path == "/api/account/login-methods/bind" {
        (
            "BIND_METHOD",
            "ProductBindRequest",
            "/api/v2/users/me/login-methods/bind".into(),
        )
    } else {
        ensure(
            parts.len() == 5 && ["replace", "unlink"].contains(&parts[4]),
            404,
            "NOT_FOUND",
        )?;
        shape("Id", &json!(parts[3]))?;
        (
            if parts[4] == "replace" {
                "REPLACE_METHOD"
            } else {
                "UNLINK_METHOD"
            },
            if parts[4] == "replace" {
                "ProductBindRequest"
            } else {
                "ProductUnlinkRequest"
            },
            format!("/api/v2/users/me/login-methods/{}/{}", parts[3], parts[4]),
        )
    };
    shape(schema, b)?;
    s.fresh().await?;
    let key = s.a.header("Idempotency-Key");
    ensure((16..=128).contains(&key.len()), 400, "INVALID_REQUEST")?;
    let handle = text(b, "reauthHandle");
    let t = s.data["transactions"][&handle].clone();
    let fingerprint = crate::security::hash(&json!({"path":path,"body":b}).to_string());
    if !t["receipt"].is_null() {
        ensure(
            t["receipt"]["key"] == key && t["receipt"]["hash"] == fingerprint,
            409,
            "IDEMPOTENCY_CONFLICT",
        )?;
        return Ok(t["receipt"]["result"].clone());
    }
    ensure(
        t["purpose"] == "REAUTH" && t["operation"] == operation && !t["operationProof"].is_null(),
        403,
        "FORBIDDEN",
    )?;
    ensure(
        t["expiresAt"]
            .as_str()
            .map(js_sys::Date::parse)
            .unwrap_or(0.0)
            > now() as f64,
        409,
        "TRANSACTION_EXPIRED",
    )?;
    if operation == "REPLACE_METHOD" || operation == "UNLINK_METHOD" {
        ensure(t["target"]["bindingId"] == parts[3], 403, "FORBIDDEN")?;
    }
    let mut input =
        json!({"operationProof":t["operationProof"],"expectedVersion":b["expectedVersion"]});
    let identity = text(b, "identityHandle");
    if schema == "ProductBindRequest" {
        let verified = &s.data["transactions"][&identity];
        ensure(
            verified["parent"] == handle
                && !verified["newIdentityProof"].is_null()
                && verified["expiresAt"]
                    .as_str()
                    .map(js_sys::Date::parse)
                    .unwrap_or(0.0)
                    > now() as f64,
            403,
            "FORBIDDEN",
        )?;
        input["newIdentityProof"] = verified["newIdentityProof"].clone();
    }
    if operation == "CHANGE_PASSWORD" {
        input["newPassword"] = b["newPassword"].clone();
    }
    let result = s
        .call(&target, Method::Post, Some(input), None, Some(&key))
        .await?;
    s.data["transactions"][&handle]["operationProof"] = Value::Null;
    s.data["transactions"][&handle]["receipt"] =
        json!({"key":key,"hash":fingerprint,"result":result});
    if !identity.is_empty() {
        s.data["transactions"][identity]["newIdentityProof"] = Value::Null;
    }
    Ok(result)
}
