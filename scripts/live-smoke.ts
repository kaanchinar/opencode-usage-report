/**
 * Manual, opt-in live smoke check. Hits the real provider APIs with the real
 * credentials resolved from your environment/auth.json. Never run in CI.
 *
 * Usage: npm run smoke -- --yes-live
 *
 * Key material is never printed: reports carry only adapter-sanitized messages.
 */
import process from "node:process";
import { collectReports } from "../src/report.js";
import { renderText } from "../src/render.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--yes-live")) {
    console.error(
      "live-smoke hits real provider APIs with your real credentials.\n" +
        "Re-run with: npm run smoke -- --yes-live",
    );
    process.exitCode = 1;
    return;
  }

  const reports = await collectReports({ refresh: true });
  console.log(renderText(reports));

  const failed = reports.filter((report) => report.source === "error");
  if (failed.length > 0) {
    console.error(`\n${failed.length} provider(s) failed: ${failed.map((r) => r.provider).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("live-smoke crashed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
