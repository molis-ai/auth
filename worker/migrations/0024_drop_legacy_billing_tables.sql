-- Drop legacy commercial/subscription tables from Auth D1.
-- All billing catalog, orders, subscriptions, credits, and entitlements live in `molis-billing`.
DROP TABLE IF EXISTS billing_seat_assignment;
DROP TABLE IF EXISTS billing_seat_pool;
DROP TABLE IF EXISTS billing_subscription;
DROP TABLE IF EXISTS billing_plan_seat_feature;
DROP TABLE IF EXISTS billing_plan_seat_type;
DROP TABLE IF EXISTS billing_plan_personal_feature;
DROP TABLE IF EXISTS billing_plan_version;
DROP TABLE IF EXISTS billing_seat_type;
DROP TABLE IF EXISTS billing_feature;
DROP TABLE IF EXISTS billing_user_revision;
