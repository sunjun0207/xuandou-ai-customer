import type { ReactNode } from "react";

export function RichText({ text }: { text: string }) {
  const blocks = splitFences(text);
  return (
    <div className="rich">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <pre key={index}>
            <code>{block.value}</code>
          </pre>
        ) : block.value.startsWith("- ") ? (
          <ul key={index}>
            {block.value.split("\n").map((line, lineIndex) => (
              <li key={lineIndex}>{inline(line.replace(/^- /, ""))}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{inline(block.value)}</p>
        ),
      )}
    </div>
  );
}

function splitFences(text: string): Array<{ kind: "text" | "code"; value: string }> {
  const blocks: Array<{ kind: "text" | "code"; value: string }> = [];
  const parts = text.split("```");
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const value = part.replace(/^\w*\n/, "");
      blocks.push({ kind: "code", value });
      return;
    }
    if (part.trim()) blocks.push({ kind: "text", value: part.trim() });
  });
  if (blocks.length === 0) blocks.push({ kind: "text", value: text });
  return blocks;
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(...lines(text.slice(last, match.index), key));
    key += 1;
    const token = match[0];
    if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else {
      const label = token.slice(1, token.indexOf("]"));
      const href = token.slice(token.indexOf("(") + 1, -1);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
    key += 1;
  }
  if (last < text.length) nodes.push(...lines(text.slice(last), key));
  return nodes;
}

function lines(text: string, key: number): ReactNode[] {
  const parts = text.split("\n");
  const nodes: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(<br key={`${key}-br-${index}`} />);
    if (part) nodes.push(part);
  });
  return nodes;
}
