import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";

export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx("prose-tandem", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Never load remote images from model output (tracking pixels, exfiltration via URL).
          img: ({ alt }) => <span className="text-muted">[image: {alt}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
