export type BillingOwner =
  | { ownerKind: "USER"; ownerId?: string }
  | { ownerKind: "TENANT"; ownerId: string };

export type BillingProduct = "WORK";
export type BillingInterval = "MONTH" | "YEAR";

export interface BillingSubject {
  product: BillingProduct;
  ownerKind: BillingOwner["ownerKind"];
  ownerId: string;
}

export interface BillingPlan {
  planId: string;
  planVersion: number;
  product: BillingProduct;
  ownerKind: BillingOwner["ownerKind"];
  name: string;
  currency: string;
  monthlyPriceMinor: number;
  yearlyPriceMinor: number;
  monthlyCredits: number;
}

export interface CreateBillingOrder {
  planId: string;
  interval: BillingInterval;
  billingTimeZone?: string;
}

export interface BillingOrderPeriod {
  orderId: string;
  startsAt: number;
  endsAt: number;
  revokedAt: number | null;
}

export interface BillingOrder extends BillingSubject {
  id: string;
  actorUserId: string;
  planId: string;
  planVersion: number;
  interval: BillingInterval;
  currency: string;
  amountMinor: number;
  monthlyCredits: number;
  billingTimeZone: string;
  status: "PENDING_PAYMENT" | "EXPIRED" | "PAID" | "REFUNDED";
  createdAt: number;
  paymentExpiresAt: number;
  paidAt: number | null;
  refundedAt: number | null;
  servicePeriod: BillingOrderPeriod | null;
  refundable: boolean;
}

export interface BillingSubscriptionPeriod {
  orderId?: string;
  startsAt: number;
  endsAt: number;
  planId: string;
  planVersion: number;
  planName: string;
  interval: BillingInterval;
  monthlyCredits: number;
}

export interface BillingSubscription extends BillingSubject {
  billingTimeZone: string | null;
  currentPeriod: BillingSubscriptionPeriod | null;
  futurePeriod: BillingSubscriptionPeriod | null;
  paidThroughAt: number | null;
}

export interface BillingBalance extends BillingSubject {
  available: number;
  currentCreditPeriod: { startsAt: number; expiresAt: number } | null;
}

export interface BillingLedgerEntry {
  id: string;
  kind: "GRANT" | "HOLD" | "SETTLE" | "RELEASE" | "CONSUME" | "EXPIRE" | "REVOKE";
  creditPeriodId: string;
  holdId: string | null;
  deltaGranted: number;
  deltaAvailable: number;
  deltaReserved: number;
  deltaConsumed: number;
  deltaExpired: number;
  referenceId: string | null;
  actorUserId: string | null;
  callingService: string;
  requestId: string;
  occurredAt: number;
  createdAt: number;
}

export interface BillingPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BillingEntitlement {
  active: boolean;
  planId: string | null;
  endsAt: number | null;
}

export type BillingReply<T> =
  | { data: T; requestId: string }
  | { error: { code: string; message: string }; requestId: string };
