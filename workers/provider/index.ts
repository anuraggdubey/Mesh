import "dotenv/config";
import { pathToFileURL } from "node:url";
import { configureProviderCli, startProviderWorker } from "./worker";

export { startProviderWorker } from "./worker";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (configureProviderCli(process.argv.slice(2))) {
      startProviderWorker().catch((error: unknown) => {
        process.stderr.write(
          `mesh provider worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      });
    }
  } catch (error) {
    process.stderr.write(
      `mesh provider worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
