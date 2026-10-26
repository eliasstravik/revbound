import type { ReactNode } from "react";
import type { Manifest } from "revbound";
import { Shell } from "./shell.js";

/** app/layout.tsx's body: the page with the console's frame around it. */
export default function Layout({ manifest, children }: { manifest: Manifest; children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell manifest={manifest}>{children}</Shell>
      </body>
    </html>
  );
}
