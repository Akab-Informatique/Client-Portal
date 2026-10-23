/* Portail AKAB — service worker: only shows the push notifications (sign-in requests) and opens the approval page. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const signin = data.type === "signin";
  // the portal's notifications (the bell), for the phones that take them
  if (data.type === "notify") {
    event.waitUntil(
      self.registration.showNotification(data.title || "Portail AKAB", {
        body: data.body || "",
        icon: "/akab-icon.png",
        badge: "/akab-icon.png",
        tag: "akab-" + (data.notifType || "notify"),
        renotify: true,
        data,
      }),
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Portail AKAB", {
      body: data.body || "",
      icon: "/akab-icon.png",
      badge: "/akab-icon.png",
      tag: signin ? "akab-signin" : "akab",
      renotify: true,
      // a sign-in request stays on the screen until it is answered
      requireInteraction: signin,
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  // only a path of this portal (never another site)
  const own = (u) => typeof u === "string" && u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\");
  const url = d.type === "signin" && d.challengeId ? "/approve?c=" + encodeURIComponent(d.challengeId) : d.type === "notify" && own(d.url) ? d.url : "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          if ("navigate" in c) return c.navigate(url).catch(() => self.clients.openWindow(url));
          return;
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
