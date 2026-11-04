import {
  env,
  applyD1Migrations,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import marketplaceWorker from "../src/marketplace-worker";
import type { Env } from "../src/types";
import { randomToken } from "../src/customer-auth";
import { sha256 } from "../src/access";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const origin = "https://max.test";

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

async function customerFixture() {
  const id = crypto.randomUUID();
  const token = randomToken();
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO customer_accounts(id,identity_subject,name) VALUES (?,?,?)",
    ).bind(id, id, "Wardrobe Customer"),
    bindings.DB.prepare("INSERT INTO customer_sessions VALUES (?,?,?)").bind(
      await sha256(token),
      id,
      Date.now() + 60_000,
    ),
  ]);
  return { id, cookie: `max_session=${token}` };
}

async function checkout(cookie: string, items: unknown[], extra: Record<string, unknown> = {}) {
  return marketplaceWorker.fetch(
    new Request(`${origin}/api/wardrobe/checkout`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items,
        shippingAddress: {
          name: "MAX Customer",
          line1: "1 Example Street",
          city: "Example City",
          state: "CA",
          postalCode: "90000",
          country: "US",
        },
      }),
    }),
    { ...bindings, MARKETPLACE_ORIGIN: origin, ...extra } as Env,
  );
}

async function productFixture(stock: number, priceCents = 1250) {
  const productId = crypto.randomUUID();
  const variantId = crypto.randomUUID();
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO wardrobe_products(id,title,price_cents) VALUES (?,?,?)",
    ).bind(productId, "Test Wardrobe Product", priceCents),
    bindings.DB.prepare(
      "INSERT INTO wardrobe_variants(id,product_id,stock_quantity) VALUES (?,?,?)",
    ).bind(variantId, productId, stock),
  ]);
  return { productId, variantId };
}

describe("Wardrobe checkout", () => {
  it("requires a customer session and validates the cart", async () => {
    const anonymous = await checkout("", [{ variantId: "variant", quantity: 1 }]);
    expect(anonymous.status).toBe(401);

    const customer = await customerFixture();
    const invalid = await checkout(customer.cookie, [{ variantId: "variant", quantity: 0 }]);
    expect(invalid.status).toBe(400);
  });

  it("creates a paid order and decrements variant inventory atomically", async () => {
    const customer = await customerFixture();
    const { variantId } = await productFixture(4);
    const response = await checkout(customer.cookie, [{ variantId, quantity: 2 }]);
    expect(response.status).toBe(201);
    const result = await response.json() as { orderId: string; totalCents: number; status: string };
    expect(result).toMatchObject({ totalCents: 2500, status: "PAID" });
    expect(
      await bindings.DB.prepare("SELECT stock_quantity FROM wardrobe_variants WHERE id=?")
        .bind(variantId).first("stock_quantity"),
    ).toBe(2);
    expect(
      await bindings.DB.prepare("SELECT quantity,unit_price_cents FROM wardrobe_order_items WHERE order_id=?")
        .bind(result.orderId).first(),
    ).toEqual({ quantity: 2, unit_price_cents: 1250 });
  });

  it("does not oversell when concurrent checkouts contend for the last unit", async () => {
    const firstCustomer = await customerFixture();
    const secondCustomer = await customerFixture();
    const { variantId } = await productFixture(1);
    const responses = await Promise.all([
      checkout(firstCustomer.cookie, [{ variantId, quantity: 1 }]),
      checkout(secondCustomer.cookie, [{ variantId, quantity: 1 }]),
    ]);
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400 || status === 409)).toHaveLength(1);
    expect(
      await bindings.DB.prepare("SELECT stock_quantity FROM wardrobe_variants WHERE id=?")
        .bind(variantId).first("stock_quantity"),
    ).toBe(0);
    expect(
      await bindings.DB.prepare("SELECT COUNT(*) FROM wardrobe_order_items WHERE variant_id=?")
        .bind(variantId).first("COUNT(*)"),
    ).toBe(1);
  });
});
