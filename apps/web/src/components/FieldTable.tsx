import type { ProductRecord } from "@mclab/shopify-online-store";

import { evidenceStateLabel } from "../preview-evidence";

const FIELD_LABELS: Array<[keyof ProductRecord["fields"], string]> = [
  ["title", "Product title"],
  ["vendor_brand", "Brand / vendor"],
  ["product_type_category", "Product type / category"],
  ["price", "Current price"],
  ["currency", "Currency"],
  ["availability", "Availability"],
  ["canonical_url", "Canonical URL"],
  ["sku", "SKU"],
  ["barcode", "Barcode / GTIN"],
  ["image", "Image"],
  ["shipping_details", "Shipping details (JSON-LD)"],
  ["merchant_return_policy", "Return policy (JSON-LD)"],
  ["warranty", "Warranty (JSON-LD)"],
  ["taxonomy_hints", "Collection-or-taxonomy hints"],
];

export function FieldTable({ record }: { record: ProductRecord }) {
  return (
    <div className="table-wrap">
      <table className="field-table">
        <thead>
          <tr><th scope="col">Field</th><th scope="col">Observed value</th><th scope="col">Evidence state</th></tr>
        </thead>
        <tbody>
          {FIELD_LABELS.map(([key, label]) => {
            const field = record.fields[key];
            return (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td data-label="Observed value" className="field-observed-val">{formatField(key, field.value, record)}</td>
                <td data-label="Evidence state"><span className={`state state-${field.state}`}>{labelForState(field.state)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatField(
  key: keyof ProductRecord["fields"],
  value: string | number | boolean | null,
  record: ProductRecord,
): string {
  if (value === null) return record.fields[key].state === "conflicted" ? "Sources disagree" : "Not observed";
  if (key === "price" && typeof value === "number") {
    const currency = record.fields.currency.value;
    if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
      try {
        return new Intl.NumberFormat("en", { style: "currency", currency }).format(value / 100);
      } catch {
        return `${currency} ${(value / 100).toFixed(2)}`;
      }
    }
    return `${(value / 100).toFixed(2)} (currency unresolved)`;
  }
  if (key === "availability" && typeof value === "boolean") return value ? "In stock" : "Out of stock";
  return String(value);
}

function labelForState(state: ProductRecord["fields"][keyof ProductRecord["fields"]]["state"]): string {
  return evidenceStateLabel(state);
}
