"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type AuthFormState } from "./actions";

export function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    mode === "signin" ? signIn : signUp,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Email
        <input name="email" type="email" required autoComplete="email" className="input" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          className="input"
        />
      </label>

      {state.error && <p className="notice notice-error">{state.error}</p>}
      {state.message && <p className="notice notice-ok">{state.message}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="text-sm text-muted hover:text-fg"
      >
        {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
