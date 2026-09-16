import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Providers } from "@/components/providers";
import { NoSpace } from "@/components/shell/no-space";
import { Sidebar } from "@/components/shell/sidebar";
import { ViewerNotice } from "@/components/shell/viewer-notice";
import { SPACE_COOKIE } from "@/lib/space-cookie";
import { supabaseServer } from "@/lib/supabase/server";
import type { SpaceInfo } from "@/lib/types";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  const email = user.email ?? "";

  const [{ data: spaceRows }, { data: platformAdmin }, cookieStore] = await Promise.all([
    supabase.rpc("my_spaces"),
    supabase.rpc("is_platform_admin"),
    cookies(),
  ]);
  const spaces = (spaceRows ?? []) as SpaceInfo[];
  const active = spaces.filter((s) => !s.disabled);

  if (active.length === 0) {
    return <NoSpace email={email} disabled={spaces.length > 0} />;
  }

  const remembered = cookieStore.get(SPACE_COOKIE)?.value;
  const initial = active.find((s) => s.id === remembered) ?? active[0]!;

  return (
    <Providers spaces={active} initialSpaceId={initial.id} isPlatformAdmin={platformAdmin === true}>
      <Sidebar email={email} />
      <main className="min-h-dvh md:pl-60">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
          <ViewerNotice />
          {children}
        </div>
      </main>
    </Providers>
  );
}
