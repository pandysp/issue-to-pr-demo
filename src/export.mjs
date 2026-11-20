// Turns selected orders into CSV. Only the public columns are exported.

export const PUBLIC_COLUMNS = ['id', 'customer', 'total', 'status'];

export function escapeField(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(orders, columns = PUBLIC_COLUMNS) {
  const lines = [columns.join(',')];
  for (let i = 0; i < orders.length; i++) {
    lines.push(columns.map((column) => escapeField(orders[i][column])).join(','));
  }
  return lines.join('\n') + '\n';
}
