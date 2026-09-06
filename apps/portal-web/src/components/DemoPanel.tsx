import { useEffect, useState } from "react";
import { resetDemo, simulateTraffic } from "../lib/api";
import {
  DEMO_SHORTCUT,
  demoProblem,
  isDemoShortcut,
  type PanelResult,
  resetFinished,
  trafficStarted,
} from "../lib/demo";

/**
 * The rehearsal props, behind Ctrl + Alt + D. Hidden because a Reviewer has no business
 * resetting the system or making ShopLite fail on purpose, and reachable from the portal
 * because that is where the demo is being given from: the alternative is a second terminal
 * on screen, which is the one thing a demo cannot afford.
 */

/** How long a burst runs. Long enough to cross Sentinel's window twice, short enough to watch. */
const BURST_MS = 30_000;

export function DemoPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"traffic" | "reset" | null>(null);
  const [result, setResult] = useState<PanelResult | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isDemoShortcut(event)) {
        event.preventDefault();
        setOpen((showing) => !showing);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const run = async (which: "traffic" | "reset") => {
    setBusy(which);
    setResult(null);
    try {
      setResult(
        which === "traffic"
          ? trafficStarted(await simulateTraffic(BURST_MS))
          : resetFinished(await resetDemo()),
      );
    } catch (error) {
      setResult(demoProblem(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside
      aria-label="Demo panel"
      className="fixed right-6 bottom-6 z-50 w-[22rem] border border-ink bg-card shadow-[0_8px_28px_rgba(20,22,26,0.16)]"
    >
      <header className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
        <span className="eyebrow text-ink">Demo</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="font-mono text-[11px] text-muted hover:text-ink"
        >
          esc
        </button>
      </header>

      <div className="space-y-2 px-4 py-3.5">
        <Button
          label="Simulate traffic"
          hint={`${BURST_MS / 1000}s of empty-cart checkouts at ShopLite`}
          busy={busy === "traffic"}
          disabled={busy !== null}
          onClick={() => void run("traffic")}
        />
        <Button
          label="Reset"
          hint="Reseed ShopLite, clear Tickets and Workspaces, keep Incidents"
          busy={busy === "reset"}
          disabled={busy !== null}
          onClick={() => void run("reset")}
        />
      </div>

      {result && (
        <div
          className={`border-t px-4 py-3 ${
            result.tone === "problem" ? "border-warn/40 bg-warn/5" : "border-rule bg-well"
          }`}
        >
          <p
            className={`m-0 text-[13px] font-medium ${
              result.tone === "problem" ? "text-warn" : "text-ink"
            }`}
          >
            {result.headline}
          </p>
          {result.lines.length > 0 && (
            <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
              {/* Each line begins with what it is about — a reset step's name, or one of
                  two fixed sentences — so the text is the key. */}
              {result.lines.map((line) => (
                <li key={line} className="evidence text-muted">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <footer className="border-t border-rule px-4 py-2">
        <p className="m-0 font-mono text-[10px] text-muted">{DEMO_SHORTCUT} closes this</p>
      </footer>
    </aside>
  );
}

function Button({
  label,
  hint,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full border border-rule bg-card px-3 py-2 text-left transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="block text-[13px] font-medium text-ink">
        {label}
        {busy && <span className="ml-2 font-mono text-[11px] text-muted">working…</span>}
      </span>
      <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>
    </button>
  );
}
