import type { ReactNode } from 'react';

export type DataTableColumn<Row> = Readonly<{
  key: string;
  header: string;
  render: (row: Row, index: number) => ReactNode;
  className?: string;
}>;

export function DataTable<Row>({
  label,
  columns,
  rows,
  getRowKey,
  emptyMessage = 'Belum ada data untuk ditampilkan.',
}: Readonly<{
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row, index: number) => string | number;
  emptyMessage?: string;
}>) {
  return (
    <div className="ds-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="ds-table">
        <caption className="ds-visually-hidden">{label}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={column.className} key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="ds-table__empty" colSpan={Math.max(columns.length, 1)}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={getRowKey(row, index)}>
                {columns.map((column) => (
                  <td className={column.className} key={column.key}>
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
