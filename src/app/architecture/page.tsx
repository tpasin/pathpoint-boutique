import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import ArchitectureView from "./ArchitectureView";

export const metadata: Metadata = {
  title: "Architecture · Pathpoint · Online Boutique",
  description:
    "System architecture for the Online Boutique Pathpoint: traffic lights, data flows, and file map.",
};

export default async function ArchitecturePage() {
  const filePath = path.join(process.cwd(), "ARCHITECTURE.md");
  const markdown = await readFile(filePath, "utf8");
  return <ArchitectureView markdown={markdown} />;
}
