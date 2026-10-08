"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

export interface AuthFormState {
  error?: string;
  message?: string;
}

const credentials = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

function parse(formData: FormData) {
  return credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };
  redirect("/dashboard");
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) return { error: error.message };
  if (!data.session) return { message: "Check your email to confirm your account, then sign in." };
  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}
