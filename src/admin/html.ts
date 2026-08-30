function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export { escapeHtml };

export function layout(title: string, body: string, active = "") {
  const nav = [
    ["dashboard", "Dashboard", "/admin"],
    ["customers", "Customers", "/admin/customers"],
    ["products", "Products", "/admin/products"],
    ["plans", "Plans", "/admin/plans"],
    ["subscriptions", "Subscriptions", "/admin/subscriptions"],
    ["licenses", "Licences", "/admin/licenses"]
  ]
    .map(([key, label, href]) => `<a class="nav-link${active === key ? " active" : ""}" href="${href}">${label}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · RWExec Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css">
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
  <div class="brand">RWExec<span>Admin</span></div>
  <nav>${nav}</nav>
  <form action="/admin/logout" method="post"><button class="logout" type="submit">Sign out</button></form>
</aside>
<main class="main">
  <header class="topbar"><div><div class="eyebrow">RWExec Commercial Platform</div><h1>${escapeHtml(title)}</h1></div></header>
  ${body}
</main>
</div>
</body>
</html>`;
}

export function loginPage(error = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RWExec Admin</title><link rel="stylesheet" href="/admin/assets/admin.css"></head>
<body class="login-body"><main class="login-card"><div class="brand dark">RWExec<span>Admin</span></div><h1>Admin sign in</h1><p>Use your RWExec admin API key to access the commercial dashboard.</p>${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ""}<form action="/admin/login" method="post"><label>Admin API key<input name="admin_key" type="password" autocomplete="current-password" required autofocus></label><button class="button primary full" type="submit">Sign in</button></form></main></body></html>`;
}
