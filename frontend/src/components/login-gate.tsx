import { WavetoyLogo } from "@/components/wavetoy-logo";
import { authenticate } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";

import { type FormEvent, useEffect, useState, type ReactNode } from "react";

function PassphraseForm({ onSuccess }: { onSuccess: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setLoading(true);
    setError("");
    try {
      await authenticate(passphrase);
      onSuccess();
    } catch {
      setError("Invalid passphrase");
      setFlash(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    document.title = "wavetoy - welcome";
  }, []);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), 800);
    return () => clearTimeout(timer);
  }, [flash]);

  return (
    <div className="flex min-h-screen flex-col justify-start px-8 pt-4" style={{ backgroundColor: "#000" }}>
      <form
        onSubmit={handleSubmit}
        className="relative flex w-full max-w-md flex-col items-start gap-4"
      >
        {/* Red flash overlay — sits on top, tints all text via mix-blend */}
        <div
          className="pointer-events-none absolute inset-0 z-10 transition-opacity"
          style={{
            background: "red",
            mixBlendMode: "hue",
            opacity: flash ? 1 : 0,
            transitionDuration: flash ? "0ms" : "800ms",
          }}
        />

        <WavetoyLogo className="mb-1 text-3xl" noise={flash} />

        <input
          type="password"
          placeholder="••••••"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          disabled={loading}
          className="w-64 rounded-md border border-border bg-transparent px-3 py-2 text-2xl tracking-widest text-primary/70 outline-none placeholder:text-primary/30"
        />

        <p className="mt-4 text-xs lowercase tracking-widest text-primary/50">
          welcome. type passphrase. press enter.
        </p>
      </form>
    </div>
  );
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <PassphraseForm onSuccess={() => setAuthed(true)} />;
  }

  return <>{children}</>;
}
