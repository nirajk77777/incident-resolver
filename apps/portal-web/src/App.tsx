import { useEffect, useState } from "react";
import { fetchConfig, type PortalConfig } from "./lib/api";
import { linkProps, useRoute } from "./navigation";
import { NewTicketPage } from "./pages/NewTicketPage";
import { TicketPage } from "./pages/TicketPage";
import { TicketsPage } from "./pages/TicketsPage";

/**
 * The portal: a queue, a Ticket, and the form that files one. The portal's own configuration
 * — which Resolver is running and where its traces live — is read once at startup and passed
 * down, so no page has to know what the API is configured with.
 */
export function App() {
  const [route, go] = useRoute();
  const [config, setConfig] = useState<PortalConfig | null>(null);

  useEffect(() => {
    let watching = true;
    void fetchConfig()
      .then((found) => {
        if (watching) setConfig(found);
      })
      .catch(() => {
        // Without it the trace links are simply not offered; the rest of the portal works.
      });
    return () => {
      watching = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-rule bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3.5">
          <a
            {...linkProps({ page: "tickets" }, go)}
            className="text-[12px] font-bold tracking-[0.18em] text-ink uppercase"
          >
            Incident<span className="text-accent">·</span>Resolver
          </a>
          <nav className="flex items-center gap-5">
            {config && (
              <span className="font-mono text-[11px] text-muted" title="The Resolver in use">
                resolver: {config.resolver}
              </span>
            )}
            <a
              {...linkProps({ page: "tickets" }, go)}
              className="text-[13px] text-muted hover:text-ink"
            >
              Queue
            </a>
            <a
              {...linkProps({ page: "new-ticket" }, go)}
              className="bg-ink px-3 py-1.5 text-[13px] font-medium text-paper transition-colors hover:bg-accent"
            >
              File a ticket
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {route.page === "tickets" && <TicketsPage go={go} />}
        {route.page === "ticket" && <TicketPage id={route.id} config={config} go={go} />}
        {route.page === "new-ticket" && <NewTicketPage go={go} />}
      </main>
    </div>
  );
}
