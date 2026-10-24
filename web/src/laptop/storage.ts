// localStorage that never throws (private mode / quota / disabled storage just means no memory).

export function storageGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function storageDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
