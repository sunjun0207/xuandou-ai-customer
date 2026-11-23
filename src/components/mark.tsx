export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" fill="#4d6bfe" />
      <path d="M16 6.5l1.9 6.6L24.5 15l-6.6 1.9L16 23.5l-1.9-6.6L7.5 15l6.6-1.9L16 6.5z" fill="#fff" />
    </svg>
  );
}
