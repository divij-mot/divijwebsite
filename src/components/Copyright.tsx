export function Copyright({ className }: { className?: string }) {
  return (
    <p className={className}>
      © {new Date().getFullYear()} Divij Motwani. All rights reserved.
    </p>
  );
}
