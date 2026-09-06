/**
 * Three pages, so the portal routes itself rather than taking a router: the queue, one
 * Ticket, and the form that files one. Unknown paths fall back to the queue, which is
 * always somewhere useful to be.
 */
export type Route = { page: "tickets" } | { page: "ticket"; id: string } | { page: "new-ticket" };

export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "tickets") {
    if (segments[1] === "new") return { page: "new-ticket" };
    if (segments[1] !== undefined) return { page: "ticket", id: decodeURIComponent(segments[1]) };
  }
  return { page: "tickets" };
}

export function hrefFor(route: Route): string {
  switch (route.page) {
    case "tickets":
      return "/tickets";
    case "new-ticket":
      return "/tickets/new";
    case "ticket":
      return `/tickets/${encodeURIComponent(route.id)}`;
  }
}
