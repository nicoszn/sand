import { redirect } from "next/navigation";

/** Keys are configured in `lib/config.ts` now, so this URL just forwards to
 * the remaining settings page. */
export default function KeysPage() {
  redirect("/settings");
}
