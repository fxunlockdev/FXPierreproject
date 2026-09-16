import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { AdminConsole } from "./admin-console";

export default async function AdminPage() {
  const supabase = await supabaseServer();
  const { data: isPlatformAdmin } = await supabase.rpc("is_platform_admin");
  if (isPlatformAdmin !== true) redirect("/overview");
  return <AdminConsole />;
}
