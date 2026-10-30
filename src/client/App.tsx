import { lazy, Suspense, useEffect, useState } from "react";

import { api } from "./api.ts";
import { isEmbedded, useNewerEmbedHost } from "./embedBridge.ts";
import { setMe, useMe } from "./me.ts";
import { LibraryPage } from "./pages/LibraryPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { OpenTabsStrip } from "./OpenTabsStrip.tsx";
import { useOpenTabs } from "./openTabs.ts";
import { parseRoute, usePathname } from "./router.ts";

// The editor and its renderers are most of the code; the home page loads without them.
const loadDocPage = () => import("./pages/DocPage.tsx");
const loadLocalDocPage = () => import("./local/LocalDocPage.tsx");
const DocPage = lazy(() => loadDocPage().then((module) => ({ default: module.DocPage })));
const LocalDocPage = lazy(() =>
  loadLocalDocPage().then((module) => ({ default: module.LocalDocPage })),
);
const loadSettingsPage = () => import("./pages/SettingsPage.tsx");
const SettingsPage = lazy(() =>
  loadSettingsPage().then((module) => ({ default: module.SettingsPage })),
);

export function App() {
  const [loaded, setLoaded] = useState(false);
  const me = useMe();
  const route = parseRoute(usePathname());
  const storedTabs = useOpenTabs();
  const newerHost = useNewerEmbedHost();
  const openTabs = isEmbedded() ? storedTabs : [];

  useEffect(() => {
    // The first page's data and code load beside the sign-in check, not after it.
    const first = parseRoute(window.location.pathname).name;
    if (first === "library") api.prefetchLibrary();
    if (first === "doc") void loadDocPage();
    if (first === "local") void loadLocalDocPage();
    if (first === "settings") void loadSettingsPage();
    api
      .me()
      .then(setMe, () => setMe(null))
      .finally(() => {
        // Only a home page mounting now may use it; a later one would show stale docs.
        if (parseRoute(window.location.pathname).name !== "library") api.dropLibraryPrefetch();
        setLoaded(true);
      });
  }, []);

  if (!loaded) return null;
  if (!me) return <LoginPage onSignedIn={setMe} />;

  // No app bar: home carries the account menu, and the doc header links back to home.
  return (
    <div className={openTabs.length > 0 ? "app has-open-tabs" : "app"}>
      {newerHost ? (
        <div className="embed-version-notice" role="status">
          T3 Code is newer than this UP Docs. Some features may not work until UP Docs is updated.
        </div>
      ) : null}
      {openTabs.length > 0 ? <OpenTabsStrip tabs={openTabs} route={route} /> : null}
      {route.name === "library" ? <LibraryPage /> : null}
      <Suspense fallback={null}>
        {route.name === "settings" ? <SettingsPage /> : null}
        {route.name === "doc" ? (
          <DocPage key={route.docId} docId={route.docId} tabId={route.tabId} />
        ) : null}
        {route.name === "local" ? <LocalDocPage key={route.path} path={route.path} /> : null}
      </Suspense>
    </div>
  );
}
