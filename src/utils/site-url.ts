export function normalizeSiteUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported site URL protocol.");
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";

  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/") {
    pathname = "";
  }

  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}
