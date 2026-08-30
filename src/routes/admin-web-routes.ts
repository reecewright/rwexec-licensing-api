import { Router } from "express";
import { prisma } from "../db.js";
import { clearAdminSession, createAdminSession, hasAdminSession, requireAdminSession, verifyAdminKey } from "../admin/session.js";
import { adminCss } from "../admin/styles.js";
import { escapeHtml, layout, loginPage } from "../admin/html.js";
import { generateLicenseKey, hashLicenseKey } from "../utils/license-key.js";

const router = Router();

function money(minor: number | null, currency: string) {
  if (minor === null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

function date(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Never";
}

router.get("/assets/admin.css", (_req, res) => {
  res.type("text/css").send(adminCss);
});

router.get("/login", (req, res) => {
  if (hasAdminSession(req)) return res.redirect("/admin");
  res.send(loginPage());
});

router.post("/login", (req, res) => {
  const key = String(req.body.admin_key ?? "");
  if (!verifyAdminKey(key)) {
    res.status(401).send(loginPage("That admin API key is not valid."));
    return;
  }
  createAdminSession(res);
  res.redirect("/admin");
});

router.post("/logout", (req, res) => {
  clearAdminSession(res);
  res.redirect("/admin/login");
});

router.use(requireAdminSession);

router.get("/", async (_req, res, next) => {
  try {
    const [customers, products, activeSubscriptions, activeLicenses, recentSubscriptions, recentLicenses] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count({ where: { active: true } }),
      prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING", "COMPLIMENTARY"] } } }),
      prisma.license.count({ where: { status: "ACTIVE" } }),
      prisma.subscription.findMany({ take: 8, orderBy: { createdAt: "desc" }, include: { customer: true, product: true, plan: true } }),
      prisma.license.findMany({ take: 8, orderBy: { createdAt: "desc" }, include: { customer: true, product: true, activations: { where: { deactivatedAt: null } } } })
    ]);

    const body = `<div class="cards">
      <div class="card"><div class="label">Customers</div><div class="value">${customers}</div></div>
      <div class="card"><div class="label">Products</div><div class="value">${products}</div></div>
      <div class="card"><div class="label">Live subscriptions</div><div class="value">${activeSubscriptions}</div></div>
      <div class="card"><div class="label">Active licences</div><div class="value">${activeLicenses}</div></div>
    </div>
    <div class="split">
      <section class="panel"><h2>Recent subscriptions</h2><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th>Plan</th><th>Status</th></tr></thead><tbody>${recentSubscriptions.length ? recentSubscriptions.map(s => `<tr><td>${escapeHtml(s.customer.name || s.customer.email)}<div class="muted">${escapeHtml(s.customer.email)}</div></td><td>${escapeHtml(s.product.name)}</td><td>${escapeHtml(s.plan?.name || "Custom")}</td><td><span class="status ${s.status.toLowerCase()}">${escapeHtml(s.status.replaceAll("_", " "))}</span></td></tr>`).join("") : `<tr><td colspan="4" class="muted">No subscriptions yet.</td></tr>`}</tbody></table></div></section>
      <section class="panel"><h2>Recent licences</h2><div class="table-wrap"><table><thead><tr><th>Licence</th><th>Customer</th><th>Usage</th></tr></thead><tbody>${recentLicenses.length ? recentLicenses.map(l => `<tr><td>${escapeHtml(l.product.name)}<div class="muted">•••• ${escapeHtml(l.keyLastFour)}</div></td><td>${escapeHtml(l.customer?.name || l.customer?.email || "Unassigned")}</td><td>${l.activations.length} / ${l.activationLimit}</td></tr>`).join("") : `<tr><td colspan="3" class="muted">No licences yet.</td></tr>`}</tbody></table></div></section>
    </div>`;
    res.send(layout("Dashboard", body, "dashboard"));
  } catch (error) { next(error); }
});

router.get("/customers", async (_req, res, next) => {
  try {
    const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { licenses: true, subscriptions: true } } } });
    const body = `<section class="panel"><h2>All customers</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Subscriptions</th><th>Licences</th><th>Created</th></tr></thead><tbody>${customers.length ? customers.map(c => `<tr><td>${escapeHtml(c.name || "—")}</td><td>${escapeHtml(c.email)}</td><td>${c._count.subscriptions}</td><td>${c._count.licenses}</td><td>${date(c.createdAt)}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No customers yet.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout("Customers", body, "customers"));
  } catch (error) { next(error); }
});

router.get("/products", async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { plans: true, licenses: true, subscriptions: true } } } });
    const body = `<div class="split"><section class="panel"><h2>Products</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>Slug</th><th>Plans</th><th>Subscriptions</th></tr></thead><tbody>${products.map(p => `<tr><td>${escapeHtml(p.name)}</td><td><code>${escapeHtml(p.slug)}</code></td><td>${p._count.plans}</td><td>${p._count.subscriptions}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>Add product</h2><form class="form-grid" action="/admin/products" method="post"><label>Name<input name="name" required></label><label>Slug<input name="slug" placeholder="rwexec-product" required></label><label>Description<textarea name="description" rows="3"></textarea></label><button class="button primary" type="submit">Create product</button></form></section></div>`;
    res.send(layout("Products", body, "products"));
  } catch (error) { next(error); }
});

router.post("/products", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const slug = String(req.body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!name || !slug) return res.status(400).send(layout("Products", `<div class="alert error">Name and slug are required.</div>`, "products"));
    await prisma.product.create({ data: { name, slug, description: String(req.body.description ?? "").trim() || null } });
    res.redirect("/admin/products");
  } catch (error) { next(error); }
});

router.get("/plans", async (_req, res, next) => {
  try {
    const [plans, products] = await Promise.all([
      prisma.plan.findMany({ orderBy: [{ product: { name: "asc" } }, { name: "asc" }], include: { product: true, entitlements: true, _count: { select: { subscriptions: true } } } }),
      prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } })
    ]);
    const productOptions = products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    const body = `<div class="split"><section class="panel"><h2>Plans & entitlements</h2><div class="table-wrap"><table><thead><tr><th>Plan</th><th>Product</th><th>Price</th><th>Entitlements</th><th>Customers</th></tr></thead><tbody>${plans.length ? plans.map(p => `<tr><td>${escapeHtml(p.name)}<div class="muted">${escapeHtml(p.slug)}</div></td><td>${escapeHtml(p.product.name)}</td><td>${money(p.priceMinor,p.currency)}${p.billingInterval ? ` / ${escapeHtml(p.billingInterval)}` : ""}</td><td>${p.entitlements.length ? p.entitlements.map(e => `${escapeHtml(e.label)}: ${e.type === "BOOLEAN" ? (e.enabled ? "Yes" : "No") : escapeHtml(e.limit)}`).join("<br>") : `<span class="muted">None</span>`}</td><td>${p._count.subscriptions}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No plans yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Create plan</h2><form class="form-grid" action="/admin/plans" method="post"><label>Product<select name="product_id" required>${productOptions}</select></label><label>Plan name<input name="name" required></label><label>Slug<input name="slug" placeholder="business" required></label><div class="form-grid two"><label>Price (£)<input name="price" type="number" min="0" step="0.01" placeholder="29.00"></label><label>Billing<select name="billing_interval"><option value="">None / custom</option><option value="month">Monthly</option><option value="year">Yearly</option></select></label></div><label>Entitlements <span class="muted">one per line: key|label|boolean|true or key|label|limit|5</span><textarea name="entitlements" rows="5" placeholder="updates|Plugin updates|boolean|true&#10;screens|Screens|limit|5"></textarea></label><button class="button primary" type="submit">Create plan</button></form></section></div>`;
    res.send(layout("Plans", body, "plans"));
  } catch (error) { next(error); }
});

router.post("/plans", async (req, res, next) => {
  try {
    const lines = String(req.body.entitlements ?? "").split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const entitlements = lines.map(line => {
      const [key, label, typeRaw, valueRaw] = line.split("|").map(v => v?.trim());
      const type = typeRaw?.toLowerCase() === "limit" ? "LIMIT" as const : "BOOLEAN" as const;
      return { key, label: label || key, type, enabled: type === "BOOLEAN" ? valueRaw?.toLowerCase() !== "false" : null, limit: type === "LIMIT" ? Math.max(0, Number.parseInt(valueRaw || "0", 10) || 0) : null };
    }).filter(e => e.key);
    const price = String(req.body.price ?? "").trim();
    await prisma.plan.create({ data: { productId: String(req.body.product_id), name: String(req.body.name).trim(), slug: String(req.body.slug).trim().toLowerCase().replace(/[^a-z0-9-]/g,"-"), priceMinor: price ? Math.round(Number(price) * 100) : null, billingInterval: String(req.body.billing_interval ?? "").trim() || null, entitlements: { create: entitlements } } });
    res.redirect("/admin/plans");
  } catch (error) { next(error); }
});

router.get("/subscriptions", async (_req, res, next) => {
  try {
    const [subscriptions, products, plans] = await Promise.all([
      prisma.subscription.findMany({ orderBy: { createdAt: "desc" }, include: { customer: true, product: true, plan: true, usage: true } }),
      prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      prisma.plan.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { product: true } })
    ]);
    const body = `<div class="split"><section class="panel"><h2>Subscriptions</h2><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product / plan</th><th>Status</th><th>Period end</th><th>Provider</th></tr></thead><tbody>${subscriptions.length ? subscriptions.map(s => `<tr><td>${escapeHtml(s.customer.name || s.customer.email)}<div class="muted">${escapeHtml(s.customer.email)}</div></td><td>${escapeHtml(s.product.name)}<div class="muted">${escapeHtml(s.plan?.name || "Custom")}</div></td><td><span class="status ${s.status.toLowerCase()}">${escapeHtml(s.status.replaceAll("_"," "))}</span></td><td>${date(s.currentPeriodEnd)}</td><td>${escapeHtml(s.complimentary ? "Complimentary" : s.externalProvider || "Manual")}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No subscriptions yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Add manual subscription</h2><form class="form-grid" action="/admin/subscriptions" method="post"><label>Customer email<input type="email" name="customer_email" required></label><label>Customer name<input name="customer_name"></label><label>Product<select name="product_id">${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select></label><label>Plan<select name="plan_id"><option value="">Custom / no plan</option>${plans.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.product.name)} — ${escapeHtml(p.name)}</option>`).join("")}</select></label><label><input type="checkbox" name="complimentary" value="1"> Complimentary / no billing</label><label>Current period end<input type="date" name="current_period_end"></label><button class="button primary" type="submit">Create subscription</button></form></section></div>`;
    res.send(layout("Subscriptions", body, "subscriptions"));
  } catch (error) { next(error); }
});

router.post("/subscriptions", async (req, res, next) => {
  try {
    const email = String(req.body.customer_email).trim().toLowerCase();
    const customer = await prisma.customer.upsert({ where: { email }, update: { name: String(req.body.customer_name ?? "").trim() || undefined }, create: { email, name: String(req.body.customer_name ?? "").trim() || null } });
    const complimentary = req.body.complimentary === "1";
    await prisma.subscription.create({ data: { customerId: customer.id, productId: String(req.body.product_id), planId: String(req.body.plan_id ?? "") || null, status: complimentary ? "COMPLIMENTARY" : "ACTIVE", complimentary, currentPeriodEnd: req.body.current_period_end ? new Date(`${req.body.current_period_end}T23:59:59.000Z`) : null } });
    res.redirect("/admin/subscriptions");
  } catch (error) { next(error); }
});

router.get("/licenses", async (req, res, next) => {
  try {
    const [licenses, products] = await Promise.all([
      prisma.license.findMany({ orderBy: { createdAt: "desc" }, include: { customer: true, product: true, activations: { where: { deactivatedAt: null } } } }),
      prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } })
    ]);
    const message = req.query.created === "1" ? `<div class="alert success">Licence created. The full key was shown once on the previous page.</div>` : "";
    const body = `${message}<div class="split"><section class="panel"><h2>Licences</h2><div class="table-wrap"><table><thead><tr><th>Licence</th><th>Customer</th><th>Status</th><th>Activations</th><th>Expiry</th></tr></thead><tbody>${licenses.length ? licenses.map(l => `<tr><td>${escapeHtml(l.product.name)}<div class="muted">•••• ${escapeHtml(l.keyLastFour)}</div></td><td>${escapeHtml(l.customer?.name || l.customer?.email || "Unassigned")}</td><td><span class="status ${l.status.toLowerCase()}">${escapeHtml(l.status)}</span></td><td>${l.activations.length} / ${l.activationLimit}</td><td>${date(l.expiresAt)}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No licences yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Create manual licence</h2><p class="muted">Use this for complimentary, internal or manually managed customers.</p><form class="form-grid" action="/admin/licenses" method="post"><label>Product<select name="product_id" required>${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select></label><label>Customer email<input type="email" name="customer_email"></label><label>Customer name<input name="customer_name"></label><div class="form-grid two"><label>Activation limit<input type="number" name="activation_limit" min="1" max="1000" value="1"></label><label>Expiry<input type="date" name="expires_at"></label></div><button class="button primary" type="submit">Generate licence</button></form></section></div>`;
    res.send(layout("Licences", body, "licenses"));
  } catch (error) { next(error); }
});

router.post("/licenses", async (req, res, next) => {
  try {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: String(req.body.product_id) } });
    let customerId: string | null = null;
    const email = String(req.body.customer_email ?? "").trim().toLowerCase();
    if (email) {
      const customer = await prisma.customer.upsert({ where: { email }, update: { name: String(req.body.customer_name ?? "").trim() || undefined }, create: { email, name: String(req.body.customer_name ?? "").trim() || null } });
      customerId = customer.id;
    }
    let rawKey = ""; let keyHash = "";
    for (let i=0;i<5;i+=1) {
      rawKey = generateLicenseKey(product.slug); keyHash = hashLicenseKey(rawKey);
      if (!(await prisma.license.findUnique({ where: { keyHash } }))) break;
      rawKey = ""; keyHash = "";
    }
    if (!rawKey || !keyHash) throw new Error("Could not generate a unique licence key.");
    const expiresRaw = String(req.body.expires_at ?? "").trim();
    await prisma.license.create({ data: { keyHash, keyLastFour: rawKey.slice(-4), productId: product.id, customerId, activationLimit: Math.max(1, Math.min(1000, Number.parseInt(String(req.body.activation_limit ?? "1"),10)||1)), expiresAt: expiresRaw ? new Date(`${expiresRaw}T23:59:59.000Z`) : null } });
    const body = `<div class="alert success"><strong>Licence created.</strong> Copy this key now. It cannot be retrieved again later.</div><div class="panel"><h2>${escapeHtml(product.name)}</h2><div class="secret">${escapeHtml(rawKey)}</div><p class="muted">Customer: ${escapeHtml(email || "Unassigned")} · Activations: ${escapeHtml(req.body.activation_limit || "1")} · Expiry: ${escapeHtml(expiresRaw || "Never")}</p><a class="button secondary" href="/admin/licenses">Back to licences</a></div>`;
    res.send(layout("Licence created", body, "licenses"));
  } catch (error) { next(error); }
});

export { router as adminWebRouter };
