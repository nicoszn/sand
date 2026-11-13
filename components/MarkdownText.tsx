"use client";

import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Markdown for summaries inside cards. Agents answer in Markdown ("## Top 3",
 * "**bold**", bullet lists), so rendering it as plain text leaks the syntax:
 * literal "##" and asterisks in the UI. Headings are demoted to bold text and
 * blocks collapse into inline runs, which keeps a three-line card readable
 * without a wall of headings.
 */
const components: Components = {
  h1: ({ children }) => <strong className="md-heading">{children} </strong>,
  h2: ({ children }) => <strong className="md-heading">{children} </strong>,
  h3: ({ children }) => <strong className="md-heading">{children} </strong>,
  h4: ({ children }) => <strong className="md-heading">{children} </strong>,
  h5: ({ children }) => <strong className="md-heading">{children} </strong>,
  h6: ({ children }) => <strong className="md-heading">{children} </strong>,
  p: ({ children }) => <span className="md-para">{children} </span>,
  ul: ({ children }) => <span className="md-list">{children}</span>,
  ol: ({ children }) => <span className="md-list">{children}</span>,
  li: ({ children }) => <span className="md-item">{children} </span>,
  blockquote: ({ children }) => <span className="md-quote">{children}</span>,
  pre: ({ children }) => <span className="md-code">{children}</span>,
  hr: () => <span>— </span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export function MarkdownText({ text }: { text: string }) {
  return (
    <span className="md-inline">
      <ReactMarkdown components={components}>{text}</ReactMarkdown>
    </span>
  );
}
