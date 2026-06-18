export function normalizeWasmUrl(url: string): string {
  if (typeof window !== "undefined") {
    return url;
  }

  if (url.startsWith("/@fs/")) {
    return url.slice("/@fs".length);
  }

  return url;
}

export function normalizeWasmFetchUrl(url: string): string {
  if (typeof window !== "undefined") {
    return url;
  }

  if (url.startsWith("/@fs/")) {
    return `file://${url.slice("/@fs".length)}`;
  }

  return url;
}
