import { useEffect, useRef, useState, type FormEvent } from "react";

/** Asks for a doc title (new doc or rename), then hands it to `onSubmit`. */
export function TitleDialog(props: {
  readonly heading: string;
  readonly detail: string | null;
  readonly initial: string;
  readonly submitLabel: string;
  readonly onSubmit: (title: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await props.onSubmit(title.trim());
      dialog.current?.close();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="title-dialog"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <form onSubmit={submit}>
        <h2>{props.heading}</h2>
        {props.detail ? <p className="muted">{props.detail}</p> : null}
        <input
          autoFocus
          aria-label="Title"
          placeholder="Untitled doc"
          maxLength={200}
          value={title}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setTitle(event.target.value)}
        />
        {failed ? <p className="error">That did not work. Try again.</p> : null}
        <div className="title-dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={!title.trim() || busy}>
            {props.submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
