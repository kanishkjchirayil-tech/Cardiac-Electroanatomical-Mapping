/** Original Ostium mark: an oval vessel opening crossed by an electrogram deflection. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0f1a22" />
      <ellipse cx="16" cy="16" rx="10" ry="8" fill="none" stroke="#2dd4bf" stroke-width="3" />
      <path d="M3 17h6l2.5-6 3.5 12 3-9 2 3h9" fill="none" stroke="#f2b84b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}
