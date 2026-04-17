import type { ReactNode } from "react";

export function Modal(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
