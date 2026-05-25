// PLAN-318 W5: consumer imports ToolThing through the re-exporter, not the
// definition site. Without re-export following, def→ on ToolThing wouldn't
// surface this file.
import { ToolThing } from './reexport_root';

export function use_tool(): string {
  return new ToolThing().ping();
}
