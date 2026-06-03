export function Logo({ className = "" }: { className?: string }) {
  // Alaya mark: three nested arcs forming a turning flywheel + a center node.
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-label="Alaya"
      role="img"
    >
      <circle cx="16" cy="16" r="3.2" fill="currentColor" />
      <path
        d="M16 4.5 A11.5 11.5 0 0 1 27.5 16"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M27.5 16 A11.5 11.5 0 0 1 16 27.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M16 27.5 A11.5 11.5 0 0 1 4.5 16"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.3"
      />
    </svg>
  );
}
