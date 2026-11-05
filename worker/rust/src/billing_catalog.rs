//! Append-only catalog publication; old subscriptions keep their selected version.
use crate::{
    http::*,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service},
};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const PLANS: &str = "SELECT p.*,json_array(p.plan_id,p.plan_version) id,'immutable' stamp,json_object('planId',p.plan_id,'planVersion',p.plan_version,'name',p.name,'personalFeatureIds',json((SELECT json_group_array(feature_id) FROM (SELECT feature_id FROM billing_plan_personal_feature WHERE plan_id=p.plan_id AND plan_version=p.plan_version ORDER BY feature_id))),'seatTypes',json((SELECT json_group_array(json(item)) FROM (SELECT json_object('seatTypeId',t.seat_type_id,'name',t.name,'featureIds',json((SELECT json_group_array(feature_id) FROM (SELECT feature_id FROM billing_plan_seat_feature WHERE plan_id=t.plan_id AND plan_version=t.plan_version AND seat_type_id=t.seat_type_id ORDER BY feature_id)))) item FROM billing_plan_seat_type t WHERE t.plan_id=p.plan_id AND t.plan_version=p.plan_version ORDER BY t.seat_type_id)))) definition FROM billing_plan_version p";
pub fn plan_view(r: &Value) -> Value {
    serde_json::from_str(r["definition"].as_str().expect("catalog JSON")).expect("database JSON")
}
pub fn feature_view(r: &Value) -> Value {
    json!({"featureId":r["id"],"product":r["product"],"name":r["name"]})
}
impl Service<'_> {
    pub async fn billing_plan(&self, id: &Value, version: &Value) -> Result<Value> {
        let p = self
            .a
            .s
            .one(
                &format!("{PLANS} WHERE p.plan_id=? AND p.plan_version=?"),
                vec![id.clone(), version.clone()],
            )
            .await?;
        ensure(!p.is_null(), 404, "NOT_FOUND")?;
        Ok(plan_view(&p))
    }
    pub async fn catalog_read(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        if action.op == "catalog.features" {
            protocol::page(
                self,
                action,
                ctx,
                "SELECT *, 'immutable' stamp FROM billing_feature",
                vec![],
                feature_view,
            )
            .await
        } else {
            protocol::page(self, action, ctx, PLANS, vec![], plan_view).await
        }
    }
    pub async fn catalog_change(&self, action: &Action, b: &Value) -> Result<Change> {
        let n = now();
        if action.op == "catalog.feature-create" {
            ensure(!text(b, "name").trim().is_empty(), 400, "INVALID_REQUEST")?;
            return Ok(Change::new(
                json!({"featureId":b["featureId"],"product":b["product"],"name":b["name"]}),
                vec![self.a.s.statement(
                    "INSERT INTO billing_feature VALUES (?,?,?,?)",
                    vec![
                        b["featureId"].clone(),
                        b["product"].clone(),
                        b["name"].clone(),
                        n.into(),
                    ],
                )?],
            ));
        }
        let id = json!(action.id);
        crate::sensitive_transactions::shape("Id", &id)?;
        ensure(!text(b, "name").trim().is_empty(), 400, "INVALID_REQUEST")?;
        let mut ids = HashSet::new();
        let mut features = HashSet::new();
        for f in b["personalFeatureIds"].as_array().unwrap() {
            features.insert(f.clone().as_str().unwrap().to_owned());
        }
        for t in b["seatTypes"].as_array().unwrap() {
            ensure(
                ids.insert(text(t, "seatTypeId")) && !text(t, "name").trim().is_empty(),
                400,
                "INVALID_REQUEST",
            )?;
            for f in t["featureIds"].as_array().unwrap() {
                features.insert(f.as_str().unwrap().to_owned());
            }
        }
        let refs = json!(features.into_iter().collect::<Vec<_>>()).to_string();
        let missing=self.a.s.one("SELECT count(*) n FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM billing_feature WHERE id=f.value)",vec![refs.clone().into()]).await?;
        ensure(number(&missing, "n") == 0, 400, "FEATURE_UNKNOWN")?;
        let mut w=vec![
            self.a.s.guard("NOT EXISTS(SELECT 1 FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM billing_feature WHERE id=f.value))",vec![refs.into()])?,
            self.a.s.statement("INSERT INTO billing_plan_version VALUES (?,?,?,?,?)",vec![id.clone(),b["planVersion"].clone(),b["name"].clone(),self.user(),n.into()])?,
            self.a.s.statement("INSERT INTO billing_plan_personal_feature SELECT ?,?,value FROM json_each(?)",vec![id.clone(),b["planVersion"].clone(),b["personalFeatureIds"].to_string().into()])?,
        ];
        // Set-based inserts keep large but schema-bounded plans within D1's parameter limits.
        let types = b["seatTypes"].to_string();
        w.push(self.a.s.statement("INSERT INTO billing_seat_type(id,name,created_at) SELECT json_extract(value,'$.seatTypeId'),json_extract(value,'$.name'),? FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING",vec![n.into(),types.clone().into()])?);
        w.push(self.a.s.statement("INSERT INTO billing_plan_seat_type(plan_id,plan_version,seat_type_id,name) SELECT ?,?,json_extract(value,'$.seatTypeId'),json_extract(value,'$.name') FROM json_each(?)",vec![id.clone(),b["planVersion"].clone(),types.clone().into()])?);
        w.push(self.a.s.statement("INSERT INTO billing_plan_seat_feature SELECT ?,?,json_extract(t.value,'$.seatTypeId'),f.value FROM json_each(?) t,json_each(json_extract(t.value,'$.featureIds')) f",vec![id.clone(),b["planVersion"].clone(),types.into()])?);
        let mut result = b.clone();
        result.as_object_mut().unwrap().remove("reason");
        result["planId"] = id;
        // Canonical ordering agrees with subsequent catalog reads.
        result["personalFeatureIds"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(Value::to_string);
        for t in result["seatTypes"].as_array_mut().unwrap() {
            t["featureIds"]
                .as_array_mut()
                .unwrap()
                .sort_by_key(Value::to_string);
        }
        result["seatTypes"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(|t| text(t, "seatTypeId"));
        Ok(Change::new(result, w))
    }
}
