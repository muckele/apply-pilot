import "./public.css";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-shell">
      <a className="public-skip-link" href="#public-main">
        Skip to content
      </a>
      {children}
    </div>
  );
}
