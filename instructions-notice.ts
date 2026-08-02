import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalSettingsPath } from "./config";
import type { Gate } from "./gate";

/**
 * Materialize the built-in rules into the global settings file and tell the user where
 * they landed.
 *
 * Shared by session startup and the commands that can complete the setup
 * (`/cruise-control on`, `/cruise-control model`), so the rules get written down at
 * whichever moment classification actually becomes usable rather than only on the next
 * session. `Gate.materializeInstructions` decides whether anything is owed.
 */
export function notifyIfInstructionsWritten(gate: Gate, ctx: ExtensionContext): void {
  if (!gate.materializeInstructions(ctx.cwd)) return;

  ctx.ui.notify(
    `cruise-control wrote its default rules to ${globalSettingsPath()} - edit them to tune the gate`,
    "info",
  );
}
