export function CartBadge() {
  const count = Number(localStorage.getItem('cartCount') ?? 0)
  return <span className="badge">{count}</span>
}
