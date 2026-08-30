function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export { escapeHtml };

const brandLogo = `<img class="brand-logo" src="/admin/assets/rwexec-logo.png" alt="RWExec Software Solutions">`;

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
<meta name="theme-color" content="#111827">
<link rel="icon" type="image/png" href="/admin/assets/rwexec-favicon.png">
<link rel="apple-touch-icon" href="/admin/assets/rwexec-favicon.png">
<link rel="stylesheet" href="/admin/assets/admin.css">
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
  <a class="brand brand-image" href="/admin" aria-label="RWExec Admin home">${brandLogo}<span>Admin</span></a>
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RWExec Admin</title><meta name="theme-color" content="#111827"><link rel="icon" type="image/png" href="/admin/assets/rwexec-favicon.png"><link rel="apple-touch-icon" href="/admin/assets/rwexec-favicon.png"><link rel="stylesheet" href="/admin/assets/admin.css"></head>
<body class="login-body"><main class="login-card"><div class="brand brand-image login-brand">${brandLogo}</div><h1>Admin sign in</h1><p>Use your RWExec admin API key to access the commercial dashboard.</p>${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ""}<form action="/admin/login" method="post"><label>Admin API key<input name="admin_key" type="password" autocomplete="current-password" required autofocus></label><button class="button primary full" type="submit">Sign in</button></form></main></body></html>`;
}
