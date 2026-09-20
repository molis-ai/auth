use crate::{
    http::*,
    identity::Auth,
    security::{avatar, uuid},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Url};

const SELECT: &str = "SELECT s.*,m.role,(SELECT count(*) FROM auth_membership WHERE space_id=s.id) memberCount,(SELECT u.display_name FROM auth_membership o JOIN auth_user u ON u.id=o.user_id WHERE o.space_id=s.id AND o.role='OWNER') ownerName FROM auth_space s LEFT JOIN auth_membership m ON m.space_id=s.id AND m.user_id=?";
pub struct Teams<'a> {
    pub a: &'a Auth,
    p: &'a Value,
}
impl<'a> Teams<'a> {
    pub fn new(a: &'a Auth, p: &'a Value) -> Self {
        Self { a, p }
    }
    fn user(&self) -> Value {
        self.p["userId"].clone()
    }
    fn view(&self, t: &Value) -> Value {
        json!({"id":t["id"],"name":t["name"],"description":t["description"],"avatarUrl":t["avatar_data"],"spaceType":t["space_type"],"status":t["status"],"version":t["version"],"role":t["role"],"memberCount":t["memberCount"],"ownerName":t["ownerName"],"canInspectManagement":self.p["platformAdmin"]==true || t["role"]=="OWNER" || t["role"]=="ADMIN"})
    }
    async fn team(&self, id: &str, management: bool) -> Result<Value> {
        let t = self
            .a
            .s
            .one(
                &format!("{SELECT} WHERE s.id=?"),
                vec![self.user(), id.into()],
            )
            .await?;
        ensure(
            !t.is_null()
                && (!t["role"].is_null()
                    || (self.p["platformAdmin"] == true && t["space_type"] == "TEAM")),
            403,
            "SPACE_FORBIDDEN",
        )?;
        if management {
            ensure(
                self.p["platformAdmin"] == true || t["role"] == "OWNER" || t["role"] == "ADMIN",
                403,
                "SPACE_FORBIDDEN",
            )?;
        }
        Ok(t)
    }
    fn guard(&self, id: &str, roles: &[&str], active: bool) -> Result<D1PreparedStatement> {
        let mut values = vec![id.into(), self.user()];
        values.extend(roles.iter().map(|s| json!(s)));
        self.a.s.guard(&format!("EXISTS(SELECT 1 FROM auth_space s JOIN auth_membership m ON m.space_id=s.id WHERE s.id=? AND s.space_type='TEAM' AND m.user_id=? AND m.role IN ({}){})",vec!["?";roles.len()].join(","),if active{" AND s.status='ACTIVE'"}else{""}),values)
    }
    fn audit(
        &self,
        action: &str,
        space: &str,
        target: Value,
        summary: Value,
    ) -> Result<D1PreparedStatement> {
        self.a.s.audit(
            action,
            self.user(),
            &self.a.request_id,
            space.into(),
            target,
            summary,
            false,
        )
    }
    async fn list(&self, url: &Url, teams: bool) -> Result<Value> {
        let q = query(url, "q", "");
        let order = query(url, "order", "asc");
        ensure(
            q.encode_utf16().count() <= 120 && ["asc", "desc"].contains(&order.as_str()),
            400,
            "INVALID_REQUEST",
        )?;
        let sql = format!(
            "{SELECT} WHERE {}(m.user_id IS NOT NULL OR ?=1) AND instr(lower(s.name),lower(?))>0",
            if teams {
                "s.space_type='TEAM' AND "
            } else {
                ""
            }
        );
        let mut r = self
            .a
            .s
            .paginate(
                url,
                &sql,
                vec![
                    self.user(),
                    json!(teams && self.p["platformAdmin"] == true),
                    q.into(),
                ],
                &format!("name COLLATE NOCASE {order},id {order}"),
            )
            .await?;
        for x in r["items"].as_array_mut().unwrap() {
            *x = self.view(x);
        }
        Ok(r)
    }
    async fn create(&self, b: &Value) -> Result<Value> {
        fields(b, &["name"], &["description", "avatarUrl"])?;
        let n = name(&b["name"])?;
        let desc = string(b.get("description").unwrap_or(&json!("")), 200)?.to_owned();
        let image = avatar(&b["avatarUrl"])?;
        let id = uuid();
        let time = now();
        self.a.s.batch(vec![self.a.s.statement("INSERT INTO auth_space(id,name,description,avatar_data,space_type,status,created_at,updated_at) VALUES (?,?,?,?,'TEAM','ACTIVE',?,?)",vec![id.clone().into(),n.into(),desc.into(),image,time.into(),time.into()])?,self.a.s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)",vec![id.clone().into(),self.user(),time.into()])?,self.audit("space.create",&id,Value::Null,Value::Null)?],"VERSION_CONFLICT").await?;
        Ok(self.view(&self.team(&id, false).await?))
    }
    async fn update(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["name", "version"], &["description", "avatarUrl"])?;
        ensure(b["version"].is_i64(), 400, "INVALID_REQUEST")?;
        let t = self.team(id, false).await?;
        let n = name(&b["name"])?;
        let desc = string(b.get("description").unwrap_or(&t["description"]), 200)?;
        let image = if b.get("avatarUrl").is_some() {
            avatar(&b["avatarUrl"])?
        } else {
            t["avatar_data"].clone()
        };
        self.a.s.batch(vec![self.guard(id,&["OWNER","ADMIN"],true)?,self.a.s.guard("EXISTS(SELECT 1 FROM auth_space WHERE id=? AND version=?)",vec![id.into(),b["version"].clone()])?,self.a.s.statement("UPDATE auth_space SET name=?,description=?,avatar_data=?,version=version+1,updated_at=? WHERE id=?",vec![n.into(),desc.into(),image,now().into(),id.into()])?,self.audit("space.update",id,Value::Null,format!("profile updated; version={}",number(&t,"version")+1).into())?],"VERSION_CONFLICT").await?;
        Ok(self.view(&self.team(id, false).await?))
    }
    async fn archive(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["archived", "version"], &[])?;
        ensure(
            b["archived"].is_boolean() && b["version"].is_i64(),
            400,
            "INVALID_REQUEST",
        )?;
        self.team(id, false).await?;
        self.a
            .s
            .batch(
                vec![
                    self.guard(id, &["OWNER"], false)?,
                    self.a.s.guard(
                        "EXISTS(SELECT 1 FROM auth_space WHERE id=? AND version=?)",
                        vec![id.into(), b["version"].clone()],
                    )?,
                    self.a.s.statement(
                        "UPDATE auth_space SET status=?,version=version+1,updated_at=? WHERE id=?",
                        vec![
                            json!(if b["archived"] == true {
                                "ARCHIVED"
                            } else {
                                "ACTIVE"
                            }),
                            now().into(),
                            id.into(),
                        ],
                    )?,
                    self.audit(
                        if b["archived"] == true {
                            "space.archive"
                        } else {
                            "space.restore"
                        },
                        id,
                        Value::Null,
                        Value::Null,
                    )?,
                ],
                "VERSION_CONFLICT",
            )
            .await?;
        Ok(self.view(&self.team(id, false).await?))
    }
    async fn members(&self, id: &str, url: &Url) -> Result<Value> {
        self.team(id, false).await?;
        let q = query(url, "q", "");
        let sort = query(url, "sort", "role");
        let order = query(url, "order", "desc");
        ensure(
            q.encode_utf16().count() <= 254
                && ["name", "role"].contains(&sort.as_str())
                && ["asc", "desc"].contains(&order.as_str()),
            400,
            "INVALID_REQUEST",
        )?;
        let sql = "SELECT u.id,u.display_name displayName,u.status,u.avatar_data avatarUrl,m.role,(SELECT json_group_array(canonical_email) FROM auth_user_email WHERE user_id=u.id) emails FROM auth_membership m JOIN auth_user u ON u.id=m.user_id WHERE m.space_id=? AND (instr(lower(u.display_name),lower(?))>0 OR EXISTS(SELECT 1 FROM auth_user_email e WHERE e.user_id=u.id AND instr(e.canonical_email,lower(?))>0))";
        let sorting = if sort == "name" {
            format!("displayName COLLATE NOCASE {order},id")
        } else {
            format!(
                "CASE role WHEN 'OWNER' THEN 4 WHEN 'ADMIN' THEN 3 WHEN 'MEMBER' THEN 2 ELSE 1 END {order},displayName COLLATE NOCASE,id"
            )
        };
        let mut r = self
            .a
            .s
            .paginate(
                url,
                sql,
                vec![id.into(), q.clone().into(), q.into()],
                &sorting,
            )
            .await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["emails"] = parsed(x, "emails")?;
            let roles = if x["role"] == "OWNER" {
                json!(["ADMIN", "MEMBER", "VIEWER"])
            } else if x["role"] == "ADMIN" {
                json!(["MEMBER", "VIEWER"])
            } else {
                json!([])
            };
            x["permissions"] = json!({"actions":[],"invite":x["role"]=="OWNER" || x["role"]=="ADMIN","editableRoles":roles,"removableRoles":roles});
        }
        Ok(r)
    }
    async fn member_change(
        &self,
        id: &str,
        target: &str,
        role: Option<&str>,
        leave: bool,
    ) -> Result<Value> {
        let t = self.team(id, false).await?;
        let row = self
            .a
            .s
            .one(
                "SELECT role FROM auth_membership WHERE space_id=? AND user_id=?",
                vec![id.into(), target.into()],
            )
            .await?;
        ensure(
            !row.is_null() && row["role"] != "OWNER" && t["space_type"] == "TEAM",
            403,
            "ROLE_FORBIDDEN",
        )?;
        if let Some(r) = role {
            ensure(
                ["ADMIN", "MEMBER", "VIEWER"].contains(&r),
                400,
                "INVALID_REQUEST",
            )?;
        }
        if !leave {
            ensure(
                t["role"] == "OWNER"
                    || (t["role"] == "ADMIN"
                        && ["MEMBER", "VIEWER"].contains(&text(&row, "role").as_str())
                        && role.is_none_or(|r| ["MEMBER", "VIEWER"].contains(&r))),
                403,
                "ROLE_FORBIDDEN",
            )?;
        }
        let mut writes = vec![
            self.guard(
                id,
                if leave {
                    &["ADMIN", "MEMBER", "VIEWER"]
                } else {
                    &["OWNER", "ADMIN"]
                },
                role.is_some(),
            )?,
            self.a.s.guard(
                "EXISTS(SELECT 1 FROM auth_membership WHERE space_id=? AND user_id=? AND role=?)",
                vec![id.into(), target.into(), row["role"].clone()],
            )?,
        ];
        if !leave {
            writes.push(self.a.s.guard(
                "EXISTS(SELECT 1 FROM auth_membership WHERE space_id=? AND user_id=? AND role=?)",
                vec![id.into(), self.user(), t["role"].clone()],
            )?);
        }
        writes.push(if let Some(role) = role {
            self.a.s.statement(
                "UPDATE auth_membership SET role=? WHERE space_id=? AND user_id=?",
                vec![role.into(), id.into(), target.into()],
            )?
        } else {
            self.a.s.statement(
                "DELETE FROM auth_membership WHERE space_id=? AND user_id=?",
                vec![id.into(), target.into()],
            )?
        });
        writes.push(
            self.audit(
                if leave {
                    "space.member.leave"
                } else if role.is_none() {
                    "space.member.remove"
                } else {
                    "space.member.role"
                },
                id,
                target.into(),
                role.map(|r| format!("{}->{r}", text(&row, "role")))
                    .unwrap_or("membership removed; data retained".into())
                    .into(),
            )?,
        );
        self.a.s.batch(writes, "VERSION_CONFLICT").await?;
        Ok(json!({"updated":true,"removed":role.is_none(),"left":leave}))
    }
    async fn candidates(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["query"], &[])?;
        let t = self.team(id, false).await?;
        ensure(
            (t["role"] == "OWNER" || t["role"] == "ADMIN") && t["status"] == "ACTIVE",
            403,
            "SPACE_FORBIDDEN",
        )?;
        let q = string(&b["query"], 254)?.trim();
        ensure(q.encode_utf16().count() >= 2, 400, "INVALID_REQUEST")?;
        let mut rows=self.a.s.all("SELECT u.id,u.display_name displayName,e.canonical_email email,EXISTS(SELECT 1 FROM auth_membership WHERE user_id=u.id AND space_id=?) joined,EXISTS(SELECT 1 FROM auth_invitation WHERE recipient_user_id=u.id AND space_id=? AND status='PENDING' AND expires_at>?) invited FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE u.status='ACTIVE' AND (instr(lower(u.display_name),lower(?))>0 OR instr(e.canonical_email,lower(?))>0) ORDER BY u.display_name LIMIT 10",vec![id.into(),id.into(),now().into(),q.into(),q.into()]).await?;
        for x in &mut rows {
            x["joined"] = json!(number(x, "joined") != 0);
            x["invited"] = json!(number(x, "invited") != 0);
        }
        Ok(json!(rows))
    }
    async fn invite(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["email", "locale"], &[])?;
        let address = email(&b["email"])?;
        ensure(
            b["locale"] == "zh-CN" || b["locale"] == "en",
            400,
            "INVALID_REQUEST",
        )?;
        self.team(id, false).await?;
        let recipient=self.a.s.one("SELECT u.id FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE e.canonical_email=? AND u.status='ACTIVE'",vec![address.clone().into()]).await?;
        ensure(!recipient.is_null(), 400, "INVITEE_NOT_REGISTERED")?;
        let invitation = uuid();
        let n = now();
        self.a.s.batch(vec![self.guard(id,&["OWNER","ADMIN"],true)?,self.a.s.guard("NOT EXISTS(SELECT 1 FROM auth_invitation WHERE space_id=? AND recipient_user_id=? AND status='PENDING' AND expires_at>?)",vec![id.into(),recipient["id"].clone(),n.into()])?,self.a.s.statement("INSERT INTO auth_invitation VALUES (?,?,?,?,?,'PENDING',?,?)",vec![invitation.clone().into(),id.into(),address.into(),recipient["id"].clone(),self.user(),n.into(),(n+604800000).into()])?,self.audit("space.invitation.create",id,recipient["id"].clone(),Value::Null)?],"VERSION_CONFLICT").await?;
        Ok(json!({"id":invitation,"spaceId":id,"status":"PENDING"}))
    }
    async fn invitations(&self, url: &Url, id: Option<&str>) -> Result<Value> {
        if let Some(id) = id {
            self.team(id, true).await?;
        }
        let sql = format!(
            "SELECT i.id,i.space_id spaceId,s.name spaceName,i.invited_email invitedEmail,u.display_name inviterName,CASE WHEN i.status='PENDING' AND i.expires_at<={} THEN 'EXPIRED' ELSE i.status END status,i.expires_at expiresAt,i.created_at createdAt FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id JOIN auth_user u ON u.id=i.inviter_user_id WHERE {}",
            now(),
            if id.is_some() {
                "i.space_id=?"
            } else {
                "i.recipient_user_id=? AND i.status='PENDING' AND i.expires_at>? AND s.status='ACTIVE'"
            }
        );
        let mut r = self
            .a
            .s
            .paginate(
                url,
                &sql,
                if let Some(id) = id {
                    vec![id.into()]
                } else {
                    vec![self.user(), now().into()]
                },
                "createdAt DESC,id DESC",
            )
            .await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["expiresAt"] = iso(&x["expiresAt"]);
            x["createdAt"] = iso(&x["createdAt"]);
        }
        Ok(r)
    }
    async fn answer(&self, id: &str, accept: bool) -> Result<Value> {
        let i = self
            .a
            .s
            .one("SELECT * FROM auth_invitation WHERE id=?", vec![id.into()])
            .await?;
        ensure(
            !i.is_null() && i["recipient_user_id"] == self.user(),
            403,
            "INVITATION_FORBIDDEN",
        )?;
        let n = now();
        let mut writes=vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id WHERE i.id=? AND i.recipient_user_id=? AND i.status='PENDING' AND i.expires_at>? AND s.status='ACTIVE')",vec![id.into(),self.user(),n.into()])?];
        if accept {
            writes.push(self.a.s.statement("INSERT INTO auth_membership VALUES (?,?,'MEMBER',?) ON CONFLICT(space_id,user_id) DO NOTHING",vec![i["space_id"].clone(),self.user(),n.into()])?);
        }
        writes.extend([
            self.a.s.statement(
                "UPDATE auth_invitation SET status=? WHERE id=?",
                vec![
                    json!(if accept { "ACCEPTED" } else { "DECLINED" }),
                    id.into(),
                ],
            )?,
            self.audit(
                if accept {
                    "space.invitation.accept"
                } else {
                    "space.invitation.decline"
                },
                &text(&i, "space_id"),
                Value::Null,
                Value::Null,
            )?,
        ]);
        self.a.s.batch(writes, "INVITATION_NOT_AVAILABLE").await?;
        Ok(json!({"accepted":accept,"declined":!accept,"spaceId":i["space_id"]}))
    }
    async fn invitation(&self, id: &str) -> Result<Value> {
        let mut row=self.a.s.one("SELECT i.id,i.recipient_user_id recipientUserId,i.space_id spaceId,s.name spaceName,i.invited_email invitedEmail,i.inviter_user_id inviterUserId,u.display_name inviterName,i.status,i.expires_at expiresAt FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id JOIN auth_user u ON u.id=i.inviter_user_id WHERE i.id=?",vec![id.into()]).await?;
        ensure(
            !row.is_null() && row["recipientUserId"] == self.user(),
            403,
            "INVITATION_FORBIDDEN",
        )?;
        row.as_object_mut().unwrap().remove("recipientUserId");
        if row["status"] == "PENDING" && number(&row, "expiresAt") <= now() {
            row["status"] = "EXPIRED".into();
        }
        row["expiresAt"] = iso(&row["expiresAt"]);
        Ok(row)
    }
    async fn revoke(&self, space: &str, id: &str) -> Result<Value> {
        self.team(space, false).await?;
        self.a.s.batch(vec![self.guard(space,&["OWNER","ADMIN"],false)?,self.a.s.guard("EXISTS(SELECT 1 FROM auth_invitation WHERE id=? AND space_id=? AND status='PENDING')",vec![id.into(),space.into()])?,self.a.s.statement("UPDATE auth_invitation SET status='REVOKED' WHERE id=? AND space_id=?",vec![id.into(),space.into()])?,self.audit("space.invitation.revoke",space,Value::Null,Value::Null)?],"VERSION_CONFLICT").await?;
        Ok(json!({"revoked":true}))
    }
    async fn audit_page(&self, id: &str, url: &Url) -> Result<Value> {
        self.team(id, true).await?;
        let mut r=self.a.s.paginate(url,"SELECT e.id,e.action,e.outcome,e.request_id requestId,e.occurred_at occurredAt,e.change_summary changeSummary,e.denial_reason denialReason,u.display_name actorName,t.display_name targetName FROM auth_audit_event e LEFT JOIN auth_user u ON u.id=e.actor_user_id LEFT JOIN auth_user t ON t.id=e.target_user_id WHERE e.space_id=?",vec![id.into()],"occurredAt DESC,id DESC").await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["occurredAt"] = iso(&x["occurredAt"]);
        }
        Ok(r)
    }
    pub async fn route(&self, path: &str, method: Method, b: &Value) -> Result<Value> {
        let url = self.a.request.url()?;
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        match (parts.as_slice(), method) {
            (["spaces"], Method::Get) => self.list(&url, false).await,
            (["spaces", "teams"], Method::Get) => self.list(&url, true).await,
            (["spaces"], Method::Post) => self.create(b).await,
            (["spaces", id], Method::Get) => Ok(self.view(&self.team(id, false).await?)),
            (["spaces", id], Method::Put) => self.update(id, b).await,
            (["spaces", id, "archive"], Method::Put) => self.archive(id, b).await,
            (["spaces", id, "members"], Method::Get) => self.members(id, &url).await,
            (["spaces", id, "invite-candidates"], Method::Post) => self.candidates(id, b).await,
            (["spaces", id, "invitations"], Method::Post) => self.invite(id, b).await,
            (["spaces", id, "invitations"], Method::Get) => self.invitations(&url, Some(id)).await,
            (["spaces", id, "audit"], Method::Get) => self.audit_page(id, &url).await,
            (["spaces", id, "leave"], Method::Post) => {
                fields(b, &[], &[])?;
                self.member_change(id, &text(self.p, "userId"), None, true)
                    .await
            }
            (["spaces", id, "members", target, "role"], Method::Put) => {
                fields(b, &["role"], &[])?;
                self.member_change(id, target, Some(string(&b["role"], 1024)?), false)
                    .await
            }
            (["spaces", id, "members", target, "remove"], Method::Post) => {
                fields(b, &[], &[])?;
                self.member_change(id, target, None, false).await
            }
            (["spaces", id, "invitations", invite, "revoke"], Method::Post) => {
                fields(b, &[], &[])?;
                self.revoke(id, invite).await
            }
            (["invitations"], Method::Get) => self.invitations(&url, None).await,
            (["invitations", id], Method::Get) => self.invitation(id).await,
            (["invitations", id, "accept"], Method::Post) => {
                fields(b, &[], &[])?;
                self.answer(id, true).await
            }
            (["invitations", id, "decline"], Method::Post) => {
                fields(b, &[], &[])?;
                self.answer(id, false).await
            }
            _ => Err(Failure {
                status: 404,
                code: "NOT_FOUND",
            }),
        }
    }
}
