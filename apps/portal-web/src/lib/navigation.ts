import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { hrefFor, parseRoute, type Route } from "./routes";

/**
 * The portal's own routing: three pages, the address bar as the state, and the back button
 * working because history does the work. Small enough that a router would be the bigger
 * moving part.
 */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: Route) => {
    window.history.pushState(null, "", hrefFor(next));
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);

  return [route, go];
}

/**
 * Links are real links: they carry an href, so they can be opened in a new tab and read by
 * a screen reader, and a plain click is handled without a page load.
 */
export function linkProps(route: Route, go: (route: Route) => void) {
  return {
    href: hrefFor(route),
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      go(route);
    },
  };
}
