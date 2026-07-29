import { browser } from '$app/environment';

// Where a passcode is allowed to live between reloads.
//
// GitHub Pages project sites all share the `*.github.io` origin, and web storage is scoped
// to the origin, not to /eventlens/. Anything stored here is readable by every other
// project on the same account. The photographer passcode is a low-privilege, event-scoped
// secret and the convenience of surviving a reload mid-event is worth it; the manager
// passcode can delete photos, so it never outlives the tab.
const PHOTOGRAPHER_KEY = 'eventlens.photographer.v1';
const MANAGER_KEY = 'eventlens.manager.v1';

// Storage access throws outright in Safari private browsing and when a quota is exhausted.
// A passcode that cannot be remembered is a small inconvenience; an exception here would
// happen during startup and take the whole app down with it.
function read(store: () => Storage, key: string): string {
  if (!browser) return '';
  try {
    return store().getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(store: () => Storage, key: string, value: string) {
  if (!browser) return;
  try {
    store().setItem(key, value);
  } catch {
    // Not remembered; the user retypes it next time.
  }
}

export const loadPhotographerPasscode = () => read(() => localStorage, PHOTOGRAPHER_KEY);
export const savePhotographerPasscode = (passcode: string) =>
  write(() => localStorage, PHOTOGRAPHER_KEY, passcode);

export const loadManagerPasscode = () => read(() => sessionStorage, MANAGER_KEY);
export const saveManagerPasscode = (passcode: string) =>
  write(() => sessionStorage, MANAGER_KEY, passcode);

export function clearPasscodes() {
  if (!browser) return;
  try {
    localStorage.removeItem(PHOTOGRAPHER_KEY);
  } catch {
    // nothing to do
  }
  try {
    sessionStorage.removeItem(MANAGER_KEY);
  } catch {
    // nothing to do
  }
}
