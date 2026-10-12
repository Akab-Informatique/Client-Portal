import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/** Tick serial numbers (with a filter when there are many). */
export function SerialChecklist({ serials, picked, onChange, empty }: { serials: { id: string; serial: string }[]; picked: string[]; onChange: (ids: string[]) => void; empty: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = serials.filter((s) => s.serial.toLowerCase().includes(q.trim().toLowerCase()));
  if (!serials.length) return <p className="rounded-lg border px-3 py-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      {serials.length > 6 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("store.filterSerials")} className="h-8" />}
      <ul className="max-h-48 overflow-y-auto rounded-lg border">
        {shown.map((s) => {
          const on = picked.includes(s.id);
          return (
            <li key={s.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={on} onCheckedChange={(v) => onChange(v ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                <span className="font-mono">{s.serial}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">{t("store.pickedCount", { count: picked.length, total: serials.length })}</p>
    </div>
  );
}
