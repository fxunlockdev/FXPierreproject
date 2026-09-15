// Theme is global external state (a class on <html> plus localStorage), so it
// lives in a tiny store consumed via useSyncExternalStore — never seeded into
// component state from an effect. The boot script in app/layout.tsx applies
// the stored theme pre-paint; SSR always renders the dark default.

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("light");
}

export function serverIsLightTheme(): boolean {
  return false;
}

export function toggleTheme(): void {
  const next = !isLightTheme();
  document.documentElement.classList.toggle("light", next);
  try {
    localStorage.setItem("sy-theme", next ? "light" : "dark");
  } catch {
    // storage may be unavailable; the class toggle still applies for this session
  }
  for (const listener of listeners) listener();
}
