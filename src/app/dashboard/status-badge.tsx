const STYLES: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "notice-ok" },
  needs_reauth: { label: "Reconnect needed", className: "notice-warn" },
  revoked: { label: "Revoked", className: "notice-error" },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? { label: status, className: "notice-warn" };
  return <span className={`notice shrink-0 px-2 py-0.5 text-xs font-medium ${style.className}`}>{style.label}</span>;
}
