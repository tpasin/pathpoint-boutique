"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type HeadingBlock = { type: "heading"; level: number; text: string; id: string };
type ParagraphBlock = { type: "paragraph"; text: string };
type CodeBlock = { type: "code"; lang: string; content: string };
type ListBlock = { type: "list"; ordered: boolean; items: string[] };
type TableBlock = { type: "table"; header: string[]; rows: string[][] };
type QuoteBlock = { type: "quote"; text: string };
type HrBlock = { type: "hr" };

type Block =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | ListBlock
  | TableBlock
  | QuoteBlock
  | HrBlock;

function slugify(raw: string, seen: Map<string, number>): string {
  const plain = raw.replace(/`/g, "").replace(/\*\*/g, "").trim();
  const base =
    plain
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "seccion";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/** Minimal markdown → block AST. No npm deps: hand-rolled for our own doc. */
function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const seenIds = new Map<string, number>();
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === "") {
      i++;
      continue;
    }

    // Fenced code block (``` or ```lang), mermaid included.
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const content: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") {
        content.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", lang, content: content.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      blocks.push({ type: "heading", level, text, id: slugify(text, seenIds) });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Table: header row + separator row required
    if (line.startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Paragraph: consume until blank line or next block start
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,4}\s/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith("|") &&
      !lines[i].trim().startsWith(">") &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^-{3,}$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

/** Inline markdown: `code`, **bold**, [text](url). Returns React nodes (JSX auto-escapes text). */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const key = `${keyPrefix}-${idx++}`;
    if (match[1] !== undefined) {
      nodes.push(<code key={key}>{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      const isInternal = href.startsWith("#");
      nodes.push(
        <a key={key} href={href} {...(isInternal ? {} : { target: "_blank", rel: "noreferrer" })}>
          {match[3]}
        </a>
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function BlockNode({ block, index }: { block: Block; index: number }) {
  const keyBase = `b${index}`;

  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(Math.max(block.level, 1), 6)}` as unknown) as
        | "h1"
        | "h2"
        | "h3"
        | "h4";
      return <Tag id={block.id}>{renderInline(block.text, keyBase)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.text, keyBase)}</p>;
    case "quote":
      return (
        <blockquote className="arch-quote">
          <p>{renderInline(block.text, keyBase)}</p>
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            <li key={`${keyBase}-${i}`}>{renderInline(item, `${keyBase}-${i}`)}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            <li key={`${keyBase}-${i}`}>{renderInline(item, `${keyBase}-${i}`)}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="arch-table-wrap">
          <table className="arch-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={`${keyBase}-h-${i}`}>{renderInline(cell, `${keyBase}-h-${i}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={`${keyBase}-r-${ri}`}>
                  {row.map((cell, ci) => (
                    <td key={`${keyBase}-r-${ri}-${ci}`}>
                      {renderInline(cell, `${keyBase}-r-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code": {
      const isMermaid = block.lang.toLowerCase() === "mermaid";
      return (
        <div className={`arch-code${isMermaid ? " arch-mermaid" : ""}`}>
          {block.lang ? <span className="arch-code-lang">{block.lang}</span> : null}
          {isMermaid ? (
            <MermaidDiagram chart={block.content} />
          ) : (
            <pre>
              <code>{block.content}</code>
            </pre>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

function TableOfContents({ blocks }: { blocks: Block[] }) {
  const entries = blocks.filter(
    (b): b is HeadingBlock =>
      b.type === "heading" && b.level === 2 && b.text.toLowerCase() !== "contents"
  );
  if (entries.length === 0) return null;
  return (
    <nav className="arch-toc" aria-label="Table of contents">
      <p className="arch-toc-title">In this document</p>
      <ol>
        {entries.map((h) => (
          <li key={h.id}>
            <a href={`#${h.id}`}>{h.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          fontFamily: "inherit",
        });
        const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }
  return <div className="arch-mermaid-svg" ref={ref} />;
}

export default function ArchitectureView({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);

  return (
    <div className="arch-page">
      <header className="arch-topbar">
        <Link href="/" className="arch-back">
          ← Back to Pathpoint
        </Link>
        <span className="arch-brand">Architecture · Online Boutique</span>
      </header>
      <div className="arch-layout">
        <TableOfContents blocks={blocks} />
        <article className="arch-doc">
          {blocks.map((block, i) => (
            <Fragment key={i}>
              <BlockNode block={block} index={i} />
            </Fragment>
          ))}
        </article>
      </div>
    </div>
  );
}
