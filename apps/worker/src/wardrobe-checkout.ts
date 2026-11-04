import type { Env } from "./types";
import { customer, readObject } from "./customer-auth";

interface CartItem {
  variantId: string;
  quantity: number;
}

interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface CheckoutBody {
  items: CartItem[];
  shippingAddress: ShippingAddress;
}

interface Variant {
  id: string;
  stock_quantity: number;
  price_cents: number;
  title: string;
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const text = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;

function parseShippingAddress(value: unknown): ShippingAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const address = value as Record<string, unknown>;
  if (
    !text(address.name, 120) ||
    !text(address.line1, 200) ||
    (address.line2 !== undefined && address.line2 !== null && !text(address.line2, 200)) ||
    !text(address.city, 100) ||
    !text(address.state, 100) ||
    !text(address.postalCode, 32) ||
    typeof address.country !== "string" || !/^[a-z]{2}$/i.test(address.country.trim())
  ) return null;

  return {
    name: address.name.trim(),
    line1: address.line1.trim(),
    ...(typeof address.line2 === "string" && address.line2.trim()
      ? { line2: address.line2.trim() }
      : {}),
    city: address.city.trim(),
    state: address.state.trim(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
  };
}

export async function handleWardrobeCheckout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await customer(request, env);
  if (!user) return json({ error: "Sign in to your MAX account to checkout" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await readObject(request);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && ["Expected a JSON object", "Request is too large"].includes(error.message))
    ) return json({ error: "Invalid request body" }, 400);
    throw error;
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "Cart is empty" }, 400);
  }
  if (body.items.length > 100) return json({ error: "Cart has too many items" }, 400);

  const shippingAddress = parseShippingAddress(body.shippingAddress);
  if (!shippingAddress) return json({ error: "A valid shipping address is required" }, 400);

  // Aggregate duplicate variants so validation, pricing, and inventory reservation
  // all use the same total quantity for each variant.
  const quantities = new Map<string, number>();
  for (const value of body.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return json({ error: "Invalid cart item structure" }, 400);
    }
    const item = value as Partial<CartItem>;
    if (
      typeof item.variantId !== "string" ||
      item.variantId.length < 1 ||
      item.variantId.length > 120 ||
      !Number.isSafeInteger(item.quantity) ||
      (item.quantity as number) <= 0 ||
      (item.quantity as number) > 99
    ) return json({ error: "Invalid cart item structure" }, 400);

    const quantity = (quantities.get(item.variantId) ?? 0) + (item.quantity as number);
    if (!Number.isSafeInteger(quantity)) return json({ error: "Invalid cart quantity" }, 400);
    quantities.set(item.variantId, quantity);
  }

  const orderId = crypto.randomUUID();
  const items: Array<{ variantId: string; quantity: number; priceCents: number }> = [];
  let totalCents = 0;

  for (const [variantId, quantity] of quantities) {
    const variant = await env.DB.prepare(
      `SELECT v.id, v.stock_quantity, p.price_cents, p.title
       FROM wardrobe_variants v
       JOIN wardrobe_products p ON v.product_id = p.id
       WHERE v.id = ?`,
    ).bind(variantId).first<Variant>();

    if (!variant) return json({ error: `Product variant not found: ${variantId}` }, 404);
    if (variant.stock_quantity < quantity) {
      return json({ error: `Insufficient stock for ${variant.title} (Available: ${variant.stock_quantity})` }, 400);
    }
    if (!Number.isSafeInteger(variant.price_cents) || variant.price_cents < 0) {
      console.error("[WardrobeCheckout] Invalid product price", { variantId });
      return json({ error: "Checkout is temporarily unavailable" }, 503);
    }

    const itemTotal = variant.price_cents * quantity;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(totalCents + itemTotal)) {
      return json({ error: "Cart total is out of range" }, 400);
    }
    totalCents += itemTotal;
    items.push({ variantId, quantity, priceCents: variant.price_cents });
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO wardrobe_orders (id, customer_id, status, total_cents, shipping_address_json)
       VALUES (?, ?, 'PAID', ?, ?)`,
    ).bind(orderId, user.id, totalCents, JSON.stringify(shippingAddress)),
  ];

  for (const item of items) {
    // The CHECK constraint on order_items.quantity makes this insert fail if
    // inventory changed after the read above. Since D1 batch is transactional,
    // that failure rolls back the order and every stock update in the batch.
    statements.push(
      env.DB.prepare(
        `INSERT INTO wardrobe_order_items (id, order_id, variant_id, quantity, unit_price_cents)
         VALUES (?, ?, ?, CASE WHEN COALESCE((SELECT stock_quantity FROM wardrobe_variants WHERE id = ?), -1) >= ? THEN ? ELSE 0 END, ?)`,
      ).bind(crypto.randomUUID(), orderId, item.variantId, item.variantId, item.quantity, item.quantity, item.priceCents),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE wardrobe_variants
         SET stock_quantity = stock_quantity - ?
         WHERE id = ? AND stock_quantity >= ?`,
      ).bind(item.quantity, item.variantId, item.quantity),
    );
  }

  try {
    await env.DB.batch(statements);
    return json({
      success: true,
      orderId,
      totalCents,
      status: "PAID",
      message: "Wardrobe order successfully placed and inventory updated.",
    }, 201);
  } catch (error) {
    console.error("[WardrobeCheckout] Batch transaction failed:", error);
    return json({ error: "Checkout failed because inventory changed or the order could not be saved. Please retry." }, 409);
  }
}
