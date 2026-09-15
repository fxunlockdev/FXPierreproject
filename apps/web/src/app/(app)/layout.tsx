import { redirect } from "next/navigation";
import { Providers } from "@/components/providers";
import { Sidebar } from "@/components/shell/sidebar";
import { supabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const { data: member } = await supabase
    .from("app_members")
    .select("role")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();
  if (!member) redirect("/login?reason=not-invited");

  return (
    <Providers>
      <Sidebar email={user.email} />
      <main className="min-h-dvh md:pl-60">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">{children}</div>
      </main>
    </Providers>
  );
}
