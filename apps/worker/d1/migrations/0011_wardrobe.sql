-- Wardrobe catalog and physical-goods checkout inventory.
CREATE TABLE wardrobe_products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wardrobe_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES wardrobe_products(id) ON DELETE CASCADE,
  stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wardrobe_variants_product ON wardrobe_variants(product_id);

CREATE TABLE wardrobe_orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer_accounts(id),
  status TEXT NOT NULL CHECK (status IN ('PAID')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  shipping_address_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wardrobe_orders_customer ON wardrobe_orders(customer_id, created_at DESC);

CREATE TABLE wardrobe_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES wardrobe_orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES wardrobe_variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX idx_wardrobe_order_items_order ON wardrobe_order_items(order_id);
