import { useState } from "react";
import { ChevronIcon, InfoIcon } from "./Icons";

export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} />
        <span className="thinking-label">
          <InfoIcon size={13} />
          Thinking
        </span>
      </div>
      {open && (
        <div className="thinking-body">
          <pre>{content}</pre>
        </div>
      )}
    </div>
  );
}
