import "../(product)/product.css";

export default function SyntheticLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="product-shell min-h-screen" data-synthetic-shell>
      <main className="product-main mx-auto max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">{children}</main>
    </div>
  );
}
