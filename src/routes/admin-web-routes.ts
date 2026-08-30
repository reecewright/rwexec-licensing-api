import { Router } from "express";
import path from "node:path";
import { prisma } from "../db.js";
import { clearAdminSession, createAdminSession, hasAdminSession, requireAdminSession, verifyAdminKey } from "../admin/session.js";
import { adminCss } from "../admin/styles.js";
import { escapeHtml, layout, loginPage } from "../admin/html.js";
import { generateLicenseKey, hashLicenseKey } from "../utils/license-key.js";
import { writeAudit } from "../services/audit-service.js";

const router = Router();

function money(minor: number | null, currency: string) {
  if (minor === null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

function date(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Never";
}

async function uniqueLicenseKey(productSlug: string) {
  for (let i = 0; i < 5; i += 1) {
    const rawKey = generateLicenseKey(productSlug);
    const keyHash = hashLicenseKey(rawKey);
    if (!(await prisma.license.findUnique({ where: { keyHash } }))) return { rawKey, keyHash };
  }
  throw new Error("Could not generate a unique licence key.");
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

router.get("/assets/admin.css", (_req, res) => {
  res.type("text/css").send(adminCss);
});

router.get("/assets/rwexec-logo.png", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "src/admin/assets/rwexec-logo.png"));
});

router.get("/assets/rwexec-favicon.png", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "src/admin/assets/rwexec-favicon.png"));
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
    const body = `<section class="panel"><h2>All customers</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Account email</th><th>Billing email</th><th>Subscriptions</th><th>Licences</th><th></th></tr></thead><tbody>${customers.length ? customers.map(c => `<tr><td>${escapeHtml(c.name || "—")}</td><td>${escapeHtml(c.email)}</td><td>${escapeHtml(c.billingEmail || "Same as account")}</td><td>${c._count.subscriptions}</td><td>${c._count.licenses}</td><td><a class="table-action" href="/admin/customers/${escapeHtml(c.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="6" class="muted">No customers yet.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout("Customers", body, "customers"));
  } catch (error) { next(error); }
});

router.get("/customers/:id", async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" }, include: { product: true, plan: true } },
        licenses: { orderBy: { createdAt: "desc" }, include: { product: true, activations: { where: { deactivatedAt: null } } } }
      }
    });
    if (!customer) return res.status(404).send(layout("Customer not found", `<div class="alert error">Customer not found.</div>`, "customers"));
    const saved = req.query.saved === "1" ? `<div class="alert success">Customer details updated.</div>` : "";
    const body = `${saved}<div class="split customer-detail"><section class="panel"><h2>Customer details</h2><form class="form-grid" action="/admin/customers/${escapeHtml(customer.id)}" method="post"><label>Customer / business name<input name="name" value="${escapeHtml(customer.name || "")}" placeholder="Business or customer name"></label><label>Account email <span class="muted">Used as the main RWExec contact and customer identity.</span><input type="email" name="email" value="${escapeHtml(customer.email)}" required></label><label>Billing email <span class="muted">Optional. Leave blank to use the account email.</span><input type="email" name="billing_email" value="${escapeHtml(customer.billingEmail || "")}" placeholder="billing@example.com"></label><button class="button primary" type="submit">Save customer</button></form></section><section class="panel"><h2>Account overview</h2><dl class="detail-list"><div><dt>Created</dt><dd>${date(customer.createdAt)}</dd></div><div><dt>Subscriptions</dt><dd>${customer.subscriptions.length}</dd></div><div><dt>Licences</dt><dd>${customer.licenses.length}</dd></div></dl></section></div><section class="panel"><h2>Subscriptions</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>Plan</th><th>Status</th><th>Period end</th><th></th></tr></thead><tbody>${customer.subscriptions.length ? customer.subscriptions.map(sub => `<tr><td>${escapeHtml(sub.product.name)}</td><td>${escapeHtml(sub.plan?.name || "Custom")}</td><td><span class="status ${sub.status.toLowerCase()}">${escapeHtml(sub.status.replaceAll("_", " "))}</span></td><td>${date(sub.currentPeriodEnd)}</td><td><a class="table-action" href="/admin/subscriptions/${escapeHtml(sub.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="5" class="muted">No subscriptions.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Licences</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>Licence</th><th>Status</th><th>Activations</th><th>Expiry</th><th></th></tr></thead><tbody>${customer.licenses.length ? customer.licenses.map(licence => `<tr><td>${escapeHtml(licence.product.name)}</td><td>•••• ${escapeHtml(licence.keyLastFour)}</td><td><span class="status ${licence.status.toLowerCase()}">${escapeHtml(licence.status)}</span></td><td>${licence.activations.length} / ${licence.activationLimit}</td><td>${date(licence.expiresAt)}</td><td><a class="table-action" href="/admin/licenses/${escapeHtml(licence.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="6" class="muted">No licences.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout(customer.name || customer.email, body, "customers"));
  } catch (error) { next(error); }
});

router.post("/customers/:id", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim() || null;
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const billingEmail = String(req.body.billing_email ?? "").trim().toLowerCase() || null;
    if (!email) return res.status(400).send(layout("Customer", `<div class="alert error">Account email is required.</div>`, "customers"));
    if (billingEmail && !/^\S+@\S+\.\S+$/.test(billingEmail)) return res.status(400).send(layout("Customer", `<div class="alert error">Billing email is not valid.</div>`, "customers"));
    const existing = await prisma.customer.findFirst({ where: { email, NOT: { id: req.params.id } } });
    if (existing) return res.status(409).send(layout("Customer", `<div class="alert error">That account email already belongs to another customer.</div>`, "customers"));
    await prisma.customer.update({ where: { id: req.params.id }, data: { name, email, billingEmail } });
    res.redirect(`/admin/customers/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) { next(error); }
});

router.get("/products", async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { plans: true, licenses: true, subscriptions: true } } } });
    const body = `<div class="split"><section class="panel"><h2>Products</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>Slug</th><th>Plans</th><th>Subscriptions</th><th>Status</th></tr></thead><tbody>${products.map(p => `<tr><td>${escapeHtml(p.name)}</td><td><code>${escapeHtml(p.slug)}</code></td><td>${p._count.plans}</td><td>${p._count.subscriptions}</td><td>${p.active ? "Active" : "Inactive"}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>Add product</h2><form class="form-grid" action="/admin/products" method="post"><label>Name<input name="name" required></label><label>Slug<input name="slug" placeholder="rwexec-product" required></label><label>Description<textarea name="description" rows="3"></textarea></label><button class="button primary" type="submit">Create product</button></form></section></div>`;
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
    const body = `<div class="split"><section class="panel"><h2>Plans & entitlements</h2><div class="table-wrap"><table><thead><tr><th>Plan</th><th>Product</th><th>Price</th><th>Entitlements</th><th>Customers</th><th></th></tr></thead><tbody>${plans.length ? plans.map(p => `<tr><td>${escapeHtml(p.name)}<div class="muted">${escapeHtml(p.slug)}</div></td><td>${escapeHtml(p.product.name)}</td><td>${money(p.priceMinor,p.currency)}${p.billingInterval ? ` / ${escapeHtml(p.billingInterval)}` : ""}</td><td>${p.entitlements.length ? p.entitlements.map(e => `${escapeHtml(e.label)}: ${e.type === "BOOLEAN" ? (e.enabled ? "Yes" : "No") : escapeHtml(e.limit)}`).join("<br>") : `<span class="muted">None</span>`}</td><td>${p._count.subscriptions}</td><td><a class="table-action" href="/admin/plans/${escapeHtml(p.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="6" class="muted">No plans yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Create plan</h2><form class="form-grid" action="/admin/plans" method="post"><label>Product<select name="product_id" required>${productOptions}</select></label><label>Plan name<input name="name" required></label><label>Slug<input name="slug" placeholder="business" required></label><div class="form-grid two"><label>Price (£)<input name="price" type="number" min="0" step="0.01" placeholder="29.00"></label><label>Billing<select name="billing_interval"><option value="">None / custom</option><option value="month">Monthly</option><option value="year">Yearly</option></select></label></div><label>Entitlements <span class="muted">one per line: key|label|boolean|true or key|label|limit|5</span><textarea name="entitlements" rows="5" placeholder="updates|Plugin updates|boolean|true&#10;screens|Screens|limit|5"></textarea></label><button class="button primary" type="submit">Create plan</button></form></section></div>`;
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
    const body = `<div class="split"><section class="panel"><h2>Subscriptions</h2><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product / plan</th><th>Status</th><th>Period end</th><th>Provider</th><th></th></tr></thead><tbody>${subscriptions.length ? subscriptions.map(s => `<tr><td>${escapeHtml(s.customer.name || s.customer.email)}<div class="muted">${escapeHtml(s.customer.email)}</div></td><td>${escapeHtml(s.product.name)}<div class="muted">${escapeHtml(s.plan?.name || "Custom")}</div></td><td><span class="status ${s.status.toLowerCase()}">${escapeHtml(s.status.replaceAll("_"," "))}</span></td><td>${date(s.currentPeriodEnd)}</td><td>${escapeHtml(s.complimentary ? "Complimentary" : s.externalProvider || "Manual")}</td><td><a class="table-action" href="/admin/subscriptions/${escapeHtml(s.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="6" class="muted">No subscriptions yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Add manual subscription</h2><form class="form-grid" action="/admin/subscriptions" method="post"><label>Customer email<input type="email" name="customer_email" required></label><label>Customer name<input name="customer_name"></label><label>Billing email <span class="muted">Optional — can be changed later from Customers.</span><input type="email" name="billing_email"></label><label>Product<select name="product_id">${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select></label><label>Plan<select name="plan_id"><option value="">Custom / no plan</option>${plans.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.product.name)} — ${escapeHtml(p.name)}</option>`).join("")}</select></label><label class="checkbox-card"><input type="checkbox" name="complimentary" value="1"><span class="checkbox-copy"><span class="checkbox-title">Complimentary / no billing</span><span class="checkbox-help">No payment required. Leave the period end blank for a permanent complimentary subscription.</span></span></label><label>Current period end<input type="date" name="current_period_end"></label><button class="button primary" type="submit">Create subscription</button></form></section></div>`;
    res.send(layout("Subscriptions", body, "subscriptions"));
  } catch (error) { next(error); }
});

router.post("/subscriptions", async (req, res, next) => {
  try {
    const email = String(req.body.customer_email).trim().toLowerCase();
    const billingEmail = String(req.body.billing_email ?? "").trim().toLowerCase() || null;
    const customer = await prisma.customer.upsert({ where: { email }, update: { name: String(req.body.customer_name ?? "").trim() || undefined, ...(billingEmail ? { billingEmail } : {}) }, create: { email, name: String(req.body.customer_name ?? "").trim() || null, billingEmail } });
    const complimentary = req.body.complimentary === "1";
    const subscription = await prisma.subscription.create({ data: { customerId: customer.id, productId: String(req.body.product_id), planId: String(req.body.plan_id ?? "") || null, status: complimentary ? "COMPLIMENTARY" : "ACTIVE", complimentary, currentPeriodEnd: req.body.current_period_end ? new Date(`${req.body.current_period_end}T23:59:59.000Z`) : null } });
    await writeAudit({ action: "subscription.created", entityType: "subscription", entityId: subscription.id, summary: `Manual subscription created for ${customer.name || customer.email}` });
    res.redirect(`/admin/subscriptions/${encodeURIComponent(subscription.id)}?created=1`);
  } catch (error) { next(error); }
});

router.get("/licenses", async (req, res, next) => {
  try {
    const [licenses, subscriptions] = await Promise.all([
      prisma.license.findMany({ orderBy: { createdAt: "desc" }, include: { customer: true, product: true, activations: { where: { deactivatedAt: null } } } }),
      prisma.subscription.findMany({
        where: { status: { in: ["ACTIVE", "TRIALING", "COMPLIMENTARY"] } },
        orderBy: [{ customer: { name: "asc" } }, { createdAt: "desc" }],
        include: { customer: true, product: true, plan: true }
      })
    ]);
    const subscriptionOptions = subscriptions.map(subscription => {
      const customerName = subscription.customer.name || subscription.customer.email;
      const planName = subscription.plan?.name || "Custom";
      const billing = subscription.complimentary ? "Complimentary" : subscription.status.replaceAll("_", " ");
      return `<option value="${escapeHtml(subscription.id)}">${escapeHtml(customerName)} — ${escapeHtml(subscription.product.name)} / ${escapeHtml(planName)} (${escapeHtml(billing)})</option>`;
    }).join("");
    const message = req.query.created === "1" ? `<div class="alert success">Licence created. The full key was shown once on the previous page.</div>` : "";
    const noSubscriptions = subscriptions.length === 0 ? `<div class="alert error">Create an active or complimentary customer subscription before generating a licence.</div>` : "";
    const body = `${message}<div class="split"><section class="panel"><h2>Licences</h2><div class="table-wrap"><table><thead><tr><th>Licence</th><th>Customer</th><th>Status</th><th>Activations</th><th>Expiry</th><th></th></tr></thead><tbody>${licenses.length ? licenses.map(l => `<tr><td>${escapeHtml(l.product.name)}<div class="muted">•••• ${escapeHtml(l.keyLastFour)}</div></td><td>${escapeHtml(l.customer?.name || l.customer?.email || "Unassigned")}</td><td><span class="status ${l.status.toLowerCase()}">${escapeHtml(l.status)}</span></td><td>${l.activations.length} / ${l.activationLimit}</td><td>${date(l.expiresAt)}</td><td><a class="table-action" href="/admin/licenses/${escapeHtml(l.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="6" class="muted">No licences yet.</td></tr>`}</tbody></table></div></section><section class="panel"><h2>Create licence</h2><p class="muted">Choose an existing customer subscription. Product, plan and customer details are inherited automatically.</p>${noSubscriptions}<form class="form-grid" action="/admin/licenses" method="post"><label>Customer / subscription<select name="subscription_id" required ${subscriptions.length ? "" : "disabled"}><option value="">Select a customer subscription</option>${subscriptionOptions}</select></label><div class="form-grid two"><label>Activation limit<input type="number" name="activation_limit" min="1" max="1000" value="1"></label><label>Expiry <span class="muted">Optional. Leave blank for no licence expiry.</span><input type="date" name="expires_at"></label></div><button class="button primary" type="submit" ${subscriptions.length ? "" : "disabled"}>Generate licence</button></form></section></div>`;
    res.send(layout("Licences", body, "licenses"));
  } catch (error) { next(error); }
});

router.post("/licenses", async (req, res, next) => {
  try {
    const subscriptionId = String(req.body.subscription_id ?? "").trim();
    if (!subscriptionId) {
      return res.status(400).send(layout("Licences", `<div class="alert error">Select a customer subscription before generating a licence.</div>`, "licenses"));
    }
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { customer: true, product: true, plan: true }
    });
    if (!subscription || !["ACTIVE", "TRIALING", "COMPLIMENTARY"].includes(subscription.status)) {
      return res.status(400).send(layout("Licences", `<div class="alert error">That subscription is unavailable or is not currently entitled to a licence.</div>`, "licenses"));
    }
    const product = subscription.product;
    const customer = subscription.customer;
    const { rawKey, keyHash } = await uniqueLicenseKey(product.slug);
    const expiresRaw = String(req.body.expires_at ?? "").trim();
    const activationLimit = Math.max(1, Math.min(1000, Number.parseInt(String(req.body.activation_limit ?? "1"),10)||1));
    const licence = await prisma.license.create({ data: { keyHash, keyLastFour: rawKey.slice(-4), productId: product.id, customerId: customer.id, subscriptionId: subscription.id, activationLimit, expiresAt: expiresRaw ? new Date(`${expiresRaw}T23:59:59.000Z`) : null } });
    await writeAudit({ action: "license.created", entityType: "license", entityId: licence.id, summary: `Licence created for ${customer.name || customer.email}`, metadata: { subscriptionId: subscription.id, activationLimit } });
    const planName = subscription.plan?.name || "Custom";
    const subscriptionLabel = subscription.complimentary ? "Complimentary" : subscription.status.replaceAll("_", " ");
    const body = `<div class="alert success"><strong>Licence created.</strong> Copy this key now. It cannot be retrieved again later.</div><div class="panel"><h2>${escapeHtml(product.name)}</h2><div class="secret">${escapeHtml(rawKey)}</div><p class="muted">Customer: ${escapeHtml(customer.name || customer.email)} · Plan: ${escapeHtml(planName)} · Subscription: ${escapeHtml(subscriptionLabel)} · Activations: ${activationLimit} · Expiry: ${escapeHtml(expiresRaw || "Never")}</p><a class="button secondary" href="/admin/licenses">Back to licences</a></div>`;
    res.send(layout("Licence created", body, "licenses"));
  } catch (error) { next(error); }
});


router.get("/plans/:id", async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, include: { product: true, entitlements: true, _count: { select: { subscriptions: true } } } });
    if (!plan) return res.status(404).send(layout("Plan not found", `<div class="alert error">Plan not found.</div>`, "plans"));
    const entitlementText = plan.entitlements.map(e => `${e.key}|${e.label}|${e.type === "LIMIT" ? "limit" : "boolean"}|${e.type === "LIMIT" ? (e.limit ?? 0) : (e.enabled ? "true" : "false")}`).join("\n");
    const message = req.query.saved === "1" ? `<div class="alert success">Plan updated.</div>` : "";
    const body = `${message}<div class="split"><section class="panel"><h2>${escapeHtml(plan.product.name)} — ${escapeHtml(plan.name)}</h2><form class="form-grid" action="/admin/plans/${escapeHtml(plan.id)}" method="post"><label>Plan name<input name="name" value="${escapeHtml(plan.name)}" required></label><label>Description<textarea name="description" rows="3">${escapeHtml(plan.description || "")}</textarea></label><div class="form-grid two"><label>Price (£)<input name="price" type="number" min="0" step="0.01" value="${plan.priceMinor === null ? "" : (plan.priceMinor / 100).toFixed(2)}"></label><label>Billing<select name="billing_interval"><option value=""${!plan.billingInterval ? " selected" : ""}>None / custom</option><option value="month"${plan.billingInterval === "month" ? " selected" : ""}>Monthly</option><option value="year"${plan.billingInterval === "year" ? " selected" : ""}>Yearly</option></select></label></div><label>Entitlements <span class="muted">one per line: key|label|boolean|true or key|label|limit|5</span><textarea name="entitlements" rows="6">${escapeHtml(entitlementText)}</textarea></label><label class="checkbox-card"><input type="checkbox" name="active" value="1" ${plan.active ? "checked" : ""}><span class="checkbox-copy"><span class="checkbox-title">Plan available</span><span class="checkbox-help">Inactive plans remain on existing subscriptions but cannot be selected for new ones.</span></span></label><button class="button primary" type="submit">Save plan</button></form></section><section class="panel"><h2>Plan overview</h2><dl class="detail-list"><div><dt>Slug</dt><dd>${escapeHtml(plan.slug)}</dd></div><div><dt>Customers</dt><dd>${plan._count.subscriptions}</dd></div><div><dt>Status</dt><dd>${plan.active ? "Active" : "Inactive"}</dd></div></dl></section></div>`;
    res.send(layout(`Plan: ${plan.name}`, body, "plans"));
  } catch (error) { next(error); }
});

router.post("/plans/:id", async (req, res, next) => {
  try {
    const lines = String(req.body.entitlements ?? "").split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const entitlements = lines.map(line => {
      const [key, label, typeRaw, valueRaw] = line.split("|").map(v => v?.trim());
      const type = typeRaw?.toLowerCase() === "limit" ? "LIMIT" as const : "BOOLEAN" as const;
      return { key, label: label || key, type, enabled: type === "BOOLEAN" ? valueRaw?.toLowerCase() !== "false" : null, limit: type === "LIMIT" ? Math.max(0, Number.parseInt(valueRaw || "0", 10) || 0) : null };
    }).filter(e => e.key);
    const price = String(req.body.price ?? "").trim();
    await prisma.$transaction(async tx => {
      await tx.plan.update({ where: { id: req.params.id }, data: { name: String(req.body.name ?? "").trim(), description: String(req.body.description ?? "").trim() || null, priceMinor: price ? Math.round(Number(price) * 100) : null, billingInterval: String(req.body.billing_interval ?? "").trim() || null, active: req.body.active === "1" } });
      await tx.planEntitlement.deleteMany({ where: { planId: req.params.id } });
      if (entitlements.length) await tx.planEntitlement.createMany({ data: entitlements.map(e => ({ ...e, planId: req.params.id })) });
    });
    await writeAudit({ action: "plan.updated", entityType: "plan", entityId: req.params.id, summary: "Plan settings and entitlements updated" });
    res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) { next(error); }
});

router.get("/subscriptions/:id", async (req, res, next) => {
  try {
    const [subscription, plans] = await Promise.all([
      prisma.subscription.findUnique({ where: { id: req.params.id }, include: { customer: true, product: true, plan: true, usage: true, licenses: { include: { activations: { where: { deactivatedAt: null } } } } } }),
      prisma.plan.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { product: true } })
    ]);
    if (!subscription) return res.status(404).send(layout("Subscription not found", `<div class="alert error">Subscription not found.</div>`, "subscriptions"));
    const availablePlans = plans.filter(p => p.productId === subscription.productId);
    const notice = req.query.saved === "1" ? `<div class="alert success">Subscription updated.</div>` : req.query.created === "1" ? `<div class="alert success">Subscription created.</div>` : req.query.action ? `<div class="alert success">Subscription action completed.</div>` : "";
    const period = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.toISOString().slice(0,10) : "";
    const provider = subscription.complimentary ? "Complimentary" : subscription.externalProvider || "Manual";
    const body = `${notice}<div class="split customer-detail"><section class="panel"><h2>Subscription details</h2><form class="form-grid" action="/admin/subscriptions/${escapeHtml(subscription.id)}/update" method="post"><label>Customer<input value="${escapeHtml(subscription.customer.name || subscription.customer.email)}" disabled></label><label>Product<input value="${escapeHtml(subscription.product.name)}" disabled></label><label>Plan<select name="plan_id"><option value="">Custom / no plan</option>${availablePlans.map(p => `<option value="${escapeHtml(p.id)}"${p.id === subscription.planId ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label><label class="checkbox-card"><input type="checkbox" name="complimentary" value="1" ${subscription.complimentary ? "checked" : ""}><span class="checkbox-copy"><span class="checkbox-title">Complimentary / no billing</span><span class="checkbox-help">Manual complimentary subscriptions can remain active without a billing period.</span></span></label><label>Current period end<input type="date" name="current_period_end" value="${escapeHtml(period)}"></label><button class="button primary" type="submit">Save subscription</button></form></section><section class="panel"><h2>Account overview</h2><dl class="detail-list"><div><dt>Status</dt><dd><span class="status ${subscription.status.toLowerCase()}">${escapeHtml(statusLabel(subscription.status))}</span></dd></div><div><dt>Provider</dt><dd>${escapeHtml(provider)}</dd></div><div><dt>Cancel at period end</dt><dd>${subscription.cancelAtPeriodEnd ? "Yes" : "No"}</dd></div><div><dt>Linked licences</dt><dd>${subscription.licenses.length}</dd></div></dl></section></div><section class="panel"><h2>Subscription controls</h2><p class="muted">These are the same lifecycle states Stripe webhooks will control later.</p><div class="actions"><form method="post" action="/admin/subscriptions/${escapeHtml(subscription.id)}/action"><input type="hidden" name="action" value="reactivate"><button class="button secondary" type="submit">Reactivate</button></form><form method="post" action="/admin/subscriptions/${escapeHtml(subscription.id)}/action"><input type="hidden" name="action" value="suspend"><button class="button warning" type="submit">Suspend</button></form>${subscription.currentPeriodEnd ? `<form method="post" action="/admin/subscriptions/${escapeHtml(subscription.id)}/action"><input type="hidden" name="action" value="cancel_period_end"><button class="button secondary" type="submit">Cancel at period end</button></form>` : ""}<form method="post" action="/admin/subscriptions/${escapeHtml(subscription.id)}/action" onsubmit="return confirm('Cancel this subscription immediately? Linked licences will no longer validate while the subscription is inactive.');"><input type="hidden" name="action" value="cancel_now"><button class="button danger" type="submit">Cancel now</button></form></div></section><section class="panel"><h2>Linked licences</h2><div class="table-wrap"><table><thead><tr><th>Licence</th><th>Status</th><th>Activations</th><th></th></tr></thead><tbody>${subscription.licenses.length ? subscription.licenses.map(l => `<tr><td>•••• ${escapeHtml(l.keyLastFour)}</td><td><span class="status ${l.status.toLowerCase()}">${escapeHtml(l.status)}</span></td><td>${l.activations.length} / ${l.activationLimit}</td><td><a class="table-action" href="/admin/licenses/${escapeHtml(l.id)}">Manage</a></td></tr>`).join("") : `<tr><td colspan="4" class="muted">No licences linked to this subscription.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout("Manage subscription", body, "subscriptions"));
  } catch (error) { next(error); }
});

router.post("/subscriptions/:id/update", async (req, res, next) => {
  try {
    const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!subscription) return res.status(404).send(layout("Subscription not found", `<div class="alert error">Subscription not found.</div>`, "subscriptions"));
    const planId = String(req.body.plan_id ?? "").trim() || null;
    if (planId) {
      const plan = await prisma.plan.findUnique({ where: { id: planId } });
      if (!plan || plan.productId !== subscription.productId) return res.status(400).send(layout("Subscription", `<div class="alert error">That plan does not belong to this product.</div>`, "subscriptions"));
    }
    const complimentary = req.body.complimentary === "1";
    const periodRaw = String(req.body.current_period_end ?? "").trim();
    await prisma.subscription.update({ where: { id: subscription.id }, data: { planId, complimentary, currentPeriodEnd: periodRaw ? new Date(`${periodRaw}T23:59:59.000Z`) : null, ...(complimentary && ["ACTIVE","COMPLIMENTARY"].includes(subscription.status) ? { status: "COMPLIMENTARY" } : (!complimentary && subscription.status === "COMPLIMENTARY" ? { status: "ACTIVE" } : {})) } });
    await writeAudit({ action: "subscription.updated", entityType: "subscription", entityId: subscription.id, summary: "Subscription details updated", metadata: { planId, complimentary, currentPeriodEnd: periodRaw || null } });
    res.redirect(`/admin/subscriptions/${encodeURIComponent(subscription.id)}?saved=1`);
  } catch (error) { next(error); }
});

router.post("/subscriptions/:id/action", async (req, res, next) => {
  try {
    const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id }, include: { customer: true } });
    if (!subscription) return res.status(404).send(layout("Subscription not found", `<div class="alert error">Subscription not found.</div>`, "subscriptions"));
    const action = String(req.body.action ?? "");
    let data: any;
    if (action === "suspend") data = { status: "SUSPENDED" };
    else if (action === "cancel_now") data = { status: "CANCELED", cancelAtPeriodEnd: false };
    else if (action === "cancel_period_end") data = { cancelAtPeriodEnd: true };
    else if (action === "reactivate") data = { status: subscription.complimentary ? "COMPLIMENTARY" : "ACTIVE", cancelAtPeriodEnd: false };
    else return res.status(400).send(layout("Subscription", `<div class="alert error">Unknown subscription action.</div>`, "subscriptions"));
    await prisma.subscription.update({ where: { id: subscription.id }, data });
    await writeAudit({ action: `subscription.${action}`, entityType: "subscription", entityId: subscription.id, summary: `${action.replaceAll("_", " ")} for ${subscription.customer.name || subscription.customer.email}` });
    res.redirect(`/admin/subscriptions/${encodeURIComponent(subscription.id)}?action=1`);
  } catch (error) { next(error); }
});

router.get("/licenses/:id", async (req, res, next) => {
  try {
    const licence = await prisma.license.findUnique({ where: { id: req.params.id }, include: { customer: true, product: true, subscription: { include: { plan: true } }, activations: { orderBy: { activatedAt: "desc" } } } });
    if (!licence) return res.status(404).send(layout("Licence not found", `<div class="alert error">Licence not found.</div>`, "licenses"));
    const notice = req.query.saved === "1" ? `<div class="alert success">Licence updated.</div>` : req.query.action ? `<div class="alert success">Licence action completed.</div>` : "";
    const expiry = licence.expiresAt ? licence.expiresAt.toISOString().slice(0,10) : "";
    const subscriptionText = licence.subscription ? `${licence.subscription.plan?.name || "Custom"} — ${statusLabel(licence.subscription.status)}` : "Legacy / unlinked";
    const activeCount = licence.activations.filter(a => !a.deactivatedAt).length;
    const body = `${notice}<div class="split customer-detail"><section class="panel"><h2>${escapeHtml(licence.product.name)}</h2><form class="form-grid" action="/admin/licenses/${escapeHtml(licence.id)}/update" method="post"><label>Customer<input value="${escapeHtml(licence.customer?.name || licence.customer?.email || "Unassigned")}" disabled></label><label>Subscription<input value="${escapeHtml(subscriptionText)}" disabled></label><div class="form-grid two"><label>Activation limit<input type="number" name="activation_limit" min="1" max="1000" value="${licence.activationLimit}"></label><label>Expiry<input type="date" name="expires_at" value="${escapeHtml(expiry)}"></label></div><button class="button primary" type="submit">Save licence</button></form></section><section class="panel"><h2>Licence overview</h2><dl class="detail-list"><div><dt>Key</dt><dd>•••• ${escapeHtml(licence.keyLastFour)}</dd></div><div><dt>Status</dt><dd><span class="status ${licence.status.toLowerCase()}">${escapeHtml(licence.status)}</span></dd></div><div><dt>Active activations</dt><dd>${activeCount} / ${licence.activationLimit}</dd></div><div><dt>Created</dt><dd>${date(licence.createdAt)}</dd></div></dl></section></div><section class="panel"><h2>Licence controls</h2><div class="actions"><form method="post" action="/admin/licenses/${escapeHtml(licence.id)}/action"><input type="hidden" name="action" value="reactivate"><button class="button secondary" type="submit">Reactivate</button></form><form method="post" action="/admin/licenses/${escapeHtml(licence.id)}/action"><input type="hidden" name="action" value="suspend"><button class="button warning" type="submit">Suspend</button></form><form method="post" action="/admin/licenses/${escapeHtml(licence.id)}/action" onsubmit="return confirm('Revoke this licence? It will immediately stop validating.');"><input type="hidden" name="action" value="revoke"><button class="button danger" type="submit">Revoke</button></form><form method="post" action="/admin/licenses/${escapeHtml(licence.id)}/action" onsubmit="return confirm('Reset all active installations for this licence?');"><input type="hidden" name="action" value="reset_activations"><button class="button secondary" type="submit">Reset activations</button></form><form method="post" action="/admin/licenses/${escapeHtml(licence.id)}/action" onsubmit="return confirm('Generate a replacement key? The old key will stop working immediately and the new key will only be shown once.');"><input type="hidden" name="action" value="regenerate"><button class="button danger" type="submit">Regenerate key</button></form></div></section><section class="panel"><h2>Activation history</h2><div class="table-wrap"><table><thead><tr><th>Site</th><th>Version</th><th>Activated</th><th>Last checked</th><th>Status</th></tr></thead><tbody>${licence.activations.length ? licence.activations.map(a => `<tr><td>${escapeHtml(a.siteUrl)}</td><td>${escapeHtml(a.pluginVersion || "—")}</td><td>${date(a.activatedAt)}</td><td>${date(a.lastCheckedAt)}</td><td>${a.deactivatedAt ? `<span class="status expired">Deactivated</span>` : `<span class="status active">Active</span>`}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No activations yet.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout("Manage licence", body, "licenses"));
  } catch (error) { next(error); }
});

router.post("/licenses/:id/update", async (req, res, next) => {
  try {
    const activationLimit = Math.max(1, Math.min(1000, Number.parseInt(String(req.body.activation_limit ?? "1"), 10) || 1));
    const expiresRaw = String(req.body.expires_at ?? "").trim();
    await prisma.license.update({ where: { id: req.params.id }, data: { activationLimit, expiresAt: expiresRaw ? new Date(`${expiresRaw}T23:59:59.000Z`) : null } });
    await writeAudit({ action: "license.updated", entityType: "license", entityId: req.params.id, summary: "Licence limits or expiry updated", metadata: { activationLimit, expiresAt: expiresRaw || null } });
    res.redirect(`/admin/licenses/${encodeURIComponent(req.params.id)}?saved=1`);
  } catch (error) { next(error); }
});

router.post("/licenses/:id/action", async (req, res, next) => {
  try {
    const licence = await prisma.license.findUnique({ where: { id: req.params.id }, include: { product: true, customer: true } });
    if (!licence) return res.status(404).send(layout("Licence not found", `<div class="alert error">Licence not found.</div>`, "licenses"));
    const action = String(req.body.action ?? "");
    if (action === "regenerate") {
      const { rawKey, keyHash } = await uniqueLicenseKey(licence.product.slug);
      await prisma.license.update({ where: { id: licence.id }, data: { keyHash, keyLastFour: rawKey.slice(-4) } });
      await writeAudit({ action: "license.regenerated", entityType: "license", entityId: licence.id, summary: `Licence key regenerated for ${licence.customer?.name || licence.customer?.email || "unassigned customer"}` });
      const body = `<div class="alert success"><strong>Replacement licence key created.</strong> The previous key is now invalid. Copy the new key now; it cannot be retrieved later.</div><div class="panel"><h2>${escapeHtml(licence.product.name)}</h2><div class="secret">${escapeHtml(rawKey)}</div><p class="muted">This is the only page that displays the full replacement key.</p><a class="button secondary" href="/admin/licenses/${escapeHtml(licence.id)}">Back to licence</a></div>`;
      return res.send(layout("Licence key regenerated", body, "licenses"));
    }
    if (action === "reset_activations") {
      await prisma.activation.updateMany({ where: { licenseId: licence.id, deactivatedAt: null }, data: { deactivatedAt: new Date(), lastCheckedAt: new Date() } });
    } else if (action === "suspend") {
      await prisma.license.update({ where: { id: licence.id }, data: { status: "SUSPENDED" } });
    } else if (action === "revoke") {
      await prisma.license.update({ where: { id: licence.id }, data: { status: "REVOKED" } });
    } else if (action === "reactivate") {
      await prisma.license.update({ where: { id: licence.id }, data: { status: "ACTIVE" } });
    } else {
      return res.status(400).send(layout("Licence", `<div class="alert error">Unknown licence action.</div>`, "licenses"));
    }
    await writeAudit({ action: `license.${action}`, entityType: "license", entityId: licence.id, summary: `${action.replaceAll("_", " ")} on licence •••• ${licence.keyLastFour}` });
    res.redirect(`/admin/licenses/${encodeURIComponent(licence.id)}?action=1`);
  } catch (error) { next(error); }
});

router.get("/audit", async (_req, res, next) => {
  try {
    const events = await prisma.auditLog.findMany({ take: 100, orderBy: { createdAt: "desc" } });
    const body = `<section class="panel"><h2>Recent admin activity</h2><p class="muted">Latest 100 commercial-platform changes. Stripe webhook processing will also use persisted event records when connected.</p><div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Summary</th></tr></thead><tbody>${events.length ? events.map(e => `<tr><td>${escapeHtml(e.createdAt.toISOString().replace("T", " ").slice(0,19))}</td><td><code>${escapeHtml(e.action)}</code></td><td>${escapeHtml(e.entityType)}${e.entityId ? `<div class="muted">${escapeHtml(e.entityId)}</div>` : ""}</td><td>${escapeHtml(e.summary)}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">No audit events yet.</td></tr>`}</tbody></table></div></section>`;
    res.send(layout("Audit log", body, "audit"));
  } catch (error) { next(error); }
});

export { router as adminWebRouter };
