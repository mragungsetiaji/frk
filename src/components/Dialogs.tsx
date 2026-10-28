import { useEffect, useRef, useState } from "react";
import { Dialog, useStore } from "../store";

/** Prompt and confirm dialogs, plus the transient notice after an action. */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  return (
    <>
      {dialog && <DialogPanel key={dialog.title} dialog={dialog} />}
      <Notice />
    </>
  );
}

function DialogPanel({ dialog }: { dialog: Dialog }) {
  const [value, setValue] = useState(dialog.kind === "prompt" ? (dialog.initial ?? "") : "");
  const [option, setOption] = useState(dialog.kind === "prompt" ? (dialog.option?.initial ?? false) : false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog.kind === "prompt") {
      field.current?.focus();
      field.current?.select();
    } else {
      confirmBtn.current?.focus();
    }
  }, [dialog]);

  const cancel = () => (dialog.kind === "prompt" ? dialog.resolve(null) : dialog.resolve(false));
  const submit = () => (dialog.kind === "prompt" ? dialog.resolve({ value, option }) : dialog.resolve(true));

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
        // Enter submits a single-line prompt; a message needs Cmd/Ctrl+Enter.
        if (e.key === "Enter" && (dialog.kind !== "prompt" || !dialog.multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title">{dialog.title}</h3>
        {dialog.kind === "confirm" ? (
          <p className="modal-body">{dialog.body}</p>
        ) : (
          <>
            <label className="modal-label">
              {dialog.label}
              {dialog.multiline ? (
                <textarea ref={field} rows={8} value={value} onChange={(e) => setValue(e.target.value)} />
              ) : (
                <input ref={field} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
              )}
            </label>
            {dialog.option && (
              <label className="check">
                <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
                {dialog.option.label}
              </label>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={confirmBtn}
            className={`btn ${dialog.kind === "confirm" && dialog.danger ? "danger" : "primary"}`}
            onClick={submit}
            disabled={dialog.kind === "prompt" && !value.trim()}
          >
            {dialog.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice() {
  const notice = useStore((s) => s.notice);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!notice) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), 2800);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice || !shown) return null;
  return (
    <div className="notice" role="status">
      {notice.text}
    </div>
  );
}
