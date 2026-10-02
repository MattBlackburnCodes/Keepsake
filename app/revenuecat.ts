import { CustomerInfo, Purchases, ReservedCustomerAttribute } from "@revenuecat/purchases-js";

export const REVENUECAT_ENTITLEMENT = "keepsake_pro";

const apiKey = process.env.NEXT_PUBLIC_REVENUECAT_API_KEY;
const sandboxPurchaseUrl = process.env.NEXT_PUBLIC_REVENUECAT_PURCHASE_URL;

let purchases: Purchases | null = null;

export type SubscriptionSnapshot = {
  isPro: boolean;
  managementUrl: string | null;
};

function snapshot(customerInfo: CustomerInfo): SubscriptionSnapshot {
  return {
    isPro: Boolean(customerInfo.entitlements.active[REVENUECAT_ENTITLEMENT]),
    managementUrl: customerInfo.managementURL,
  };
}

export async function revenueCatForUser(uid: string, email?: string) {
  if (!apiKey) throw new Error("RevenueCat is not configured.");

  if (!purchases) {
    purchases = Purchases.configure({ apiKey, appUserId: uid });
  } else if (purchases.getAppUserId() !== uid) {
    await purchases.changeUser(uid);
  }

  if (email) {
    await purchases.setAttributes({ [ReservedCustomerAttribute.Email]: email }).catch(() => undefined);
  }

  return purchases;
}

export async function loadSubscription(uid: string, email?: string) {
  const client = await revenueCatForUser(uid, email);
  return snapshot(await client.getCustomerInfo());
}

export function buildSandboxPurchaseUrl(uid: string, email?: string) {
  if (!sandboxPurchaseUrl) throw new Error("The Keepsake checkout link is not configured.");
  const base = sandboxPurchaseUrl.endsWith("/") ? sandboxPurchaseUrl : `${sandboxPurchaseUrl}/`;
  const url = new URL(`${base}${encodeURIComponent(uid)}`);
  if (email) url.searchParams.set("email", email);
  return url.toString();
}
