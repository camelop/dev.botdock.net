import type { ReactNode } from "react";

/**
 * Default behavior: clicks on the backdrop do NOT dismiss the modal — a stray
 * click shouldn't nuke form data. Callers opt into backdrop-to-dismiss by
 * passing dismissOnBackdrop.
 */
export function Modal(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissOnBackdrop?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={props.dismissOnBackdrop ? props.onClose : undefined}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
